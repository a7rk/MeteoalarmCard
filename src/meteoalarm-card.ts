import {
	ActionHandlerEvent,
	debounce,
	EntityConfig,
	handleAction,
	hasAction,
	hasConfigOrEntityChanged,
	HomeAssistant,
	LovelaceCardConfig,
	LovelaceCardEditor,
} from 'custom-card-helpers';
import type { HassEntity } from 'home-assistant-js-websocket';
import { CSSResultGroup, html, LitElement, PropertyValues, TemplateResult, unsafeCSS } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { ifDefined } from 'lit/directives/if-defined.js';
import { styleMap } from 'lit/directives/style-map.js';
import Swiper, { Pagination } from 'swiper';
import swiperCss from 'swiper/css?inline';
import swiperPaginationCss from 'swiper/css/pagination?inline';
import { version as CARD_VERSION } from '../package.json';
import EventsParser from './events-parser';
import { actionHandler } from './helpers/action-handler-directive';
import { processConfigEntities } from './helpers/process-config-entities';
import INTEGRATIONS from './integrations/integrations';
import { localize } from './localize/localize';
import { getCanvasFont, getTextWidth } from './measure-text';
import styles from './styles';
import {
	DEFAULT_SCALING_MODE,
	MeteoalarmCardConfig,
	MeteoalarmIntegration,
	MeteoalarmIntegrationEntityType,
	MeteoalarmScalingMode,
	MeteoalarmDisplayMode,
	MeteoalarmAlertParsed,
} from './types';

// eslint-disable-next-line no-console
console.info(
	`%c MeteoalarmCard %c ${CARD_VERSION} `,
	'color: white; font-weight: bold; background: #1c1c1c',
	'color: white; font-weight: bold; background: #db4437',
);

// Push card into UI card picker
(window as any).customCards = (window as any).customCards || [];
(window as any).customCards.push({
	preview: true,
	type: 'meteoalarm-card',
	name: localize('common.name'),
	description: localize('common.description'),
});

@customElement('meteoalarm-card')
export class MeteoalarmCard extends LitElement {
	@property({ attribute: false }) public hass!: HomeAssistant;

	@state() private config!: MeteoalarmCardConfig;

	private resizeObserver!: ResizeObserver;

	private swiper!: Swiper;

	// Entity of which alert is displayed on currently selected slide
	// Used to display correct entity on click
	private currentEntity?: string;

	static get integrations(): MeteoalarmIntegration[] {
		return INTEGRATIONS.map((i) => new i());
	}

	public static async getConfigElement(): Promise<LovelaceCardEditor> {
		await import('./editor');
		return document.createElement('meteoalarm-card-editor');
	}

	public static getStubConfig(hass: HomeAssistant, entities: string[]): Record<string, unknown> {
		// Find fist entity that is supported by any integration
		const ALLOWED_INTEGRATION_TYPES = [
			MeteoalarmIntegrationEntityType.SingleEntity,
			MeteoalarmIntegrationEntityType.CurrentExpected,
		];

		for (const entity of entities) {
			const integrations = MeteoalarmCard.integrations.filter((x) =>
				ALLOWED_INTEGRATION_TYPES.includes(x.metadata.type),
			);
			for (const integration of integrations) {
				if (integration.supports(hass.states[entity])) {
					return {
						entities: { entity },
						integration: integration.metadata.key,
					};
				}
			}
		}
		return {
			entities: '',
			integration: '',
		};
	}

	public setConfig(config: LovelaceCardConfig): void {
		if (!config) {
			throw new Error(localize('common.invalid_configuration'));
		} else if (
			config.entities == undefined ||
			(Array.isArray(config.entities) && config.entities.length == 0) ||
			(Array.isArray(config.entities) && config.entities.every((e) => e == null))
		) {
			throw new Error(localize('error.missing_entity'));
		} else if (config.integration == undefined) {
			throw new Error(localize('error.invalid_integration'));
		}

		this.config = {
			name: 'Meteoalarm',
			...config,
		};
	}

	static get styles(): CSSResultGroup {
		return [unsafeCSS(swiperCss), unsafeCSS(swiperPaginationCss), styles];
	}

	public getCardSize(): number {
		// Prevent over-allocating space for 'badge'
		if (this.displayMode === MeteoalarmDisplayMode.Badge) return 1;

		return 2;
	}

	protected shouldUpdate(changedProps: PropertyValues): boolean {
		return hasConfigOrEntityChanged(this, changedProps, false);
	}

	public firstUpdated(): void {
		// skip if 'badge' display
		if (this.displayMode === MeteoalarmDisplayMode.Badge) return;

		this.measureCard();
		this.attachObserver();
		const swiper = (this.renderRoot as ShadowRoot).getElementById('swiper');
		if (!swiper) return;
		this.swiper = new Swiper(swiper, {
			modules: [Pagination],
			pagination: {
				el: swiper.getElementsByClassName('swiper-pagination')[0] as HTMLElement,
			},
			observer: true,
		});
		this.swiper.on('transitionEnd', () => {
			this.updateCurrentEntity();
		});
		this.swiper.on('observerUpdate', () => {
			this.updateCurrentEntity();
		});
	}

	// Updates the currentEntity variable
	private updateCurrentEntity(): void {
		const slide = this.swiper.slides[this.swiper.realIndex];
		this.currentEntity = slide.getAttribute('entity_id') as string;
	}

	private attachObserver() {
		// skip if 'badge' display
		if (this.displayMode === MeteoalarmDisplayMode.Badge) return;

		if (!this.resizeObserver) {
			this.resizeObserver = new ResizeObserver(debounce(() => this.measureCard(), 250, false));
		}
		const card = this.shadowRoot!.querySelector('ha-card');
		if (!card) return;
		this.resizeObserver.observe(card);
	}

	private getHeadlineElements(container: HTMLElement): [HTMLElement, HTMLElement, HTMLElement] {
		const regular = container.querySelector('.headline-regular') as HTMLElement;
		const narrow = container.querySelector('.headline-narrow') as HTMLElement;
		const veryNarrow = container.querySelector('.headline-verynarrow') as HTMLElement;
		return [regular, narrow, veryNarrow];
	}

	private measureCard() {
		// skip if 'badge' display
		if (this.displayMode === MeteoalarmDisplayMode.Badge) return;

		if (!this.isConnected) return;
		const card = this.shadowRoot!.querySelector('ha-card');
		if (!card) return;
		if (this.scalingMode == MeteoalarmScalingMode.Disabled) return;

		const scaleHeadline = [
			MeteoalarmScalingMode.Scale,
			MeteoalarmScalingMode.HeadlineAndScale,
		].includes(this.scalingMode);
		const swapHeadline = [
			MeteoalarmScalingMode.Headline,
			MeteoalarmScalingMode.HeadlineAndScale,
		].includes(this.scalingMode);
		const MAX_FONT_SIZE = 22;
		const MIN_FONT_SIZE = 17;

		// Scale headlines of each swiper card
		const swiper = card.querySelector('.swiper-wrapper');
		const slides = swiper?.getElementsByClassName('swiper-slide') as HTMLCollectionOf<HTMLElement>;
		for (const slide of slides) {
			const [regular, narrow, veryNarrow] = this.getHeadlineElements(slide);
			const sizes: [string, HTMLElement][] = [['regular', regular]];
			if (swapHeadline) {
				sizes.push(['narrow', narrow]);
				sizes.push(['veryNarrow', veryNarrow]);
			}

			this.setCardScaling(slide, 'regular', MAX_FONT_SIZE);

			let isSizeSet = false;
			for (const [size, element] of sizes) {
				if (isSizeSet) break;
				const minFontSize = scaleHeadline ? MIN_FONT_SIZE : MAX_FONT_SIZE;
				for (let fontSize = MAX_FONT_SIZE; fontSize >= minFontSize; fontSize--) {
					const elementSize = getTextWidth(
						element.textContent!,
						getCanvasFont(regular, fontSize + 'px'),
					);
					if (elementSize <= regular.clientWidth) {
						this.setCardScaling(slide, size as any, fontSize);
						isSizeSet = true;
						break;
					}
				}
			}

			// Fallback if measuring couldn't fit the text
			if (!isSizeSet) {
				if (swapHeadline) {
					this.setCardScaling(slide, 'icon', MAX_FONT_SIZE);
				} else {
					this.setCardScaling(slide, 'regular' as any, MIN_FONT_SIZE);
				}
			}
		}
	}

	private setCardScaling(
		container: HTMLElement,
		scale: 'regular' | 'narrow' | 'veryNarrow' | 'icon',
		fontSize: number,
	) {
		const [regular, narrow, veryNarrow] = this.getHeadlineElements(container);

		if (scale == 'regular') {
			regular.style.fontSize = `${fontSize}px`;
			regular.style.display = 'block';
			narrow.style.display = 'none';
			veryNarrow.style.display = 'none';
		} else if (scale == 'narrow') {
			narrow.style.fontSize = `${fontSize}px`;
			regular.style.display = 'none';
			narrow.style.display = 'block';
			veryNarrow.style.display = 'none';
		} else if (scale == 'veryNarrow') {
			veryNarrow.style.fontSize = `${fontSize}px`;
			regular.style.display = 'none';
			narrow.style.display = 'none';
			veryNarrow.style.display = 'block';
		} else if (scale == 'icon') {
			regular.style.display = 'none';
			narrow.style.display = 'none';
			veryNarrow.style.display = 'none';
		}
	}

	private get entities(): HassEntity[] {
		const entities: EntityConfig[] = processConfigEntities(this.config.entities!);
		return entities.map((e) => this.hass.states[e.entity]);
	}

	private get integration(): MeteoalarmIntegration {
		const integration = MeteoalarmCard.integrations.find(
			(i) => i.metadata.key === this.config.integration,
		);
		if (integration === undefined) {
			throw new Error(localize('error.invalid_integration'));
		}
		return integration!;
	}

	private get scalingMode(): MeteoalarmScalingMode {
		const modeString = this.config.scaling_mode;
		if (!modeString) return DEFAULT_SCALING_MODE;
		if (!Object.values(MeteoalarmScalingMode).includes(modeString as any)) {
			throw new Error('MeteoalarmCard: ' + localize('error.invalid_scaling_mode'));
		}
		return modeString as MeteoalarmScalingMode;
	}

	private get displayMode(): MeteoalarmDisplayMode {
		const modeString = this.config.display_mode;
		if (!modeString) return MeteoalarmDisplayMode.Card;
		if (!Object.values(MeteoalarmDisplayMode).includes(modeString as any)) {
			throw new Error('MeteoalarmCard: ' + localize('error.invalid_display_mode'));
		}
		return modeString as MeteoalarmDisplayMode;
	}

	protected render(): TemplateResult | void {
		try {
			const parser = new EventsParser(this.integration);
			const events = parser.getEvents(
				this.entities,
				this.config.disable_swiper,
				this.config.override_headline,
				this.config.hide_caption,
				this.config.ignored_levels,
				this.config.ignored_events,
			);

			// Handle hide_when_no_warning
			if (events.every((e) => !e.isActive) && this.config.hide_when_no_warning) {
				// eslint-disable-next-line no-console
				console.log(
					'MeteoalarmCard: Card is hidden - hide_when_no_warning is enabled and there are no warnings',
				);
				this.setCardMargin(false);
				return html``;
			}

			// if 'badge' display, render badge instead
			if (this.displayMode === MeteoalarmDisplayMode.Badge) {
				return this.renderBadge(events);
			}

			this.setCardMargin(true);

			return html`
				<ha-card
					@action=${this.handleAction}
					.actionHandler=${actionHandler({
						hasHold: hasAction(this.config.hold_action),
						hasDoubleClick: hasAction(this.config.double_tap_action),
					})}
					tabindex="0"
				>
					<div class="container">
						<div
							class="swiper"
							id="swiper"
						>
							<div class="swiper-wrapper">
								${events.map(
									(event) => html`
										<div
											class="swiper-slide ${event.cssClass}"
											entity_id=${ifDefined(event.entity?.entity_id)}
											style=${styleMap(this.getCardStyle(event.cssClass))}
										>
											<div class="content">
												${this.renderMainIcon(event.icon)} ${this.renderHeadlines(event.headlines)}
											</div>
											${
												event.caption && event.captionIcon
													? html`
															<div class="caption">
																${this.renderCaption(event.captionIcon, event.caption)}
															</div>
														`
													: ''
											}
										</div>
									`,
								)}
							</div>
							<div class="swiper-pagination"></div>
						</div>
					</div>
				</ha-card>
			`;
		} catch (error) {
			// eslint-disable-next-line no-console
			console.error('[METEOALARM CARD ERROR]\nReport issue: https://bit.ly/3hK1hL4 \n\n', error);
			return this.showError(error as string);
		}
	}

	// TODO: seems to be dead code
	private getSeverityText(cssClass: string): string {
		const level = this.getSeverityLevel(cssClass); // 'red' | 'orange' | 'yellow' | 'none'
		if (level === 'none') return localize('events.no_warnings');
		return localize(`messages.${level}.generic`);
	}

	private getSeverityLevel(cssClass: string): string {
		return cssClass.replace('event-', ''); // 'red' | 'orange' | 'yellow' | 'none'
	}

	private getCardStyle = (cssClass: string) => {
		const level = this.getSeverityLevel(cssClass);
		return {
			'background-color': `var(--${level}-level-background-color)`,
		};
	};

	private renderBadge(events: MeteoalarmAlertParsed[]): TemplateResult {
		const topEvent = events[0];
		if (!topEvent?.isActive && this.config.hide_when_no_warning) return html``;

		this.currentEntity = topEvent?.entity?.entity_id;

		const narrowHeadline = topEvent?.headlines[1] ?? topEvent?.headlines[0] ?? '';
		const badgeClass = topEvent.cssClass ?? 'event-none';
		const level = this.getSeverityLevel(badgeClass);

		const badgeLabel =
			topEvent.caption && topEvent.captionIcon
				? html`
						<span class="badge-caption">
							${this.renderCaption(topEvent.captionIcon, topEvent.caption)}
						</span>
					`
				: 'Alert!';

		// <ha-badge> has its own shadow-root hence custom css styles best defined inline
		// using styleMap(). Yellow badges need a dark contrast color since its background is light;
		// other levels use the standard active text color. Secondary color = primary's alpha * .8
		// (relative color syntax, requires Chrome 119+/Safari 16.4+/Firefox 128+).
		const style = {
			'--ha-card-background': `var(--${level}-level-background-color)`,
			'--primary-text-color':
				level === 'yellow' ? 'var(--text-contrast-color-active)' : 'var(--text-color-active)',
			'--secondary-text-color': 'rgb(from var(--primary-text-color) r g b / calc(alpha * .8))',
			'--badge-color': 'var(--primary-text-color)',
		};

		return html`
			<ha-badge
				.type="button"
				@action=${this.handleAction}
				.actionHandler=${actionHandler({
					hasHold: hasAction(this.config!.hold_action),
					hasDoubleClick: hasAction(this.config!.double_tap_action),
				})}
				.label=${badgeLabel}
				style=${styleMap(style)}
				class=${badgeClass}
			>
				${this.renderBadgeIcon(topEvent.icon)} ${narrowHeadline}
			</ha-badge>
		`;
	}

	private renderMainIcon(icon: string): TemplateResult {
		return html`<ha-icon
			class="main-icon"
			icon="mdi:${icon}"
		></ha-icon>`;
	}

	private renderBadgeIcon(icon: string): TemplateResult {
		return html`<ha-state-icon
			slot="icon"
			.icon="mdi:${icon}"
		></ha-state-icon>`;
	}

	// Transfer array of one, two or three headlines in descending length
	// into TemplateResult. These will be selected depending on
	// card width (screen size) by resize observer
	private renderHeadlines(headlines: string[]): TemplateResult {
		// TODO: Fix this array mess
		let regular = '',
			narrow = '',
			verynarrow = '';
		if (headlines.length == 0) {
			throw new Error('headlines array length is 0');
		} else if (headlines.length == 1) {
			regular = headlines[0];
			narrow = headlines[0];
			verynarrow = headlines[0];
		} else if (headlines.length == 2) {
			regular = headlines[0];
			narrow = headlines[1];
			verynarrow = headlines[1];
		} else if (headlines.length == 3) {
			regular = headlines[0];
			narrow = headlines[1];
			verynarrow = headlines[2];
		} else if (headlines.length > 3) {
			throw new Error('headlines array length is higher than 3');
		}

		return html`
			<div class="headline headline-regular">${regular}</div>
			<div class="headline headline-narrow">${narrow}</div>
			<div class="headline headline-verynarrow">${verynarrow}</div>
		`;
	}

	// no caption icon on 'badges'
	private renderCaption(icon: string, caption: string): TemplateResult {
		return html`
			<span class="caption-text">${caption}</span>
			${
				this.displayMode !== MeteoalarmDisplayMode.Badge
					? html`
							<ha-icon
								class="caption-icon"
								icon="mdi:${icon}"
							></ha-icon>
						`
					: ''
			}
		`;
	}

	private setCardMargin(showMargin: boolean): void {
		const container = this.shadowRoot?.host as HTMLElement;
		if (!container) return;
		container.style.margin = showMargin ? '' : '0px';
	}

	private showError(error: string): TemplateResult {
		const errorCard = document.createElement('hui-error-card');
		errorCard.setConfig({
			type: 'error',
			error,
			origConfig: this.config,
		});

		return html` ${errorCard} `;
	}

	private handleAction(ev: ActionHandlerEvent): void {
		const config = {
			...this.config,
			entity: this.currentEntity,
		};
		if (this.hass && this.config && ev.detail.action) {
			handleAction(this, this.hass, config, ev.detail.action);
		}
	}
}
