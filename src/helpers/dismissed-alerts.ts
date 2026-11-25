const KEY_PREFIX = 'meteoalarm-card:dismissed';

function storageKey(userId: string | undefined, scope: string[]): string {
	return [KEY_PREFIX, userId ?? 'anonymous', [...scope].sort().join(',')].join(':');
}

export function loadDismissedAlerts(userId: string | undefined, scope: string[]): string[] {
	try {
		const parsed = JSON.parse(localStorage.getItem(storageKey(userId, scope)) ?? '[]');
		return Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : [];
	} catch {
		return [];
	}
}

export function saveDismissedAlerts(
	userId: string | undefined,
	scope: string[],
	ids: string[],
): void {
	try {
		const key = storageKey(userId, scope);
		if (ids.length == 0) {
			localStorage.removeItem(key);
		} else {
			localStorage.setItem(key, JSON.stringify(ids));
		}
	} catch {
		// Storage can be unavailable (private mode, quota); dismissal then lasts until reload
	}
}
