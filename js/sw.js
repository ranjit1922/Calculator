// ─── Cache & Data Versioning ──────────────────────────────
const CACHE_VERSION = 'v1';
const CACHE_NAME = `SW_AI_CACHE_${CACHE_VERSION}`;
const PROFILE_STORE = 'SW_AI_PROFILE_DATA';
const DATA_MAX_AGE = 15 * 24 * 60 * 60 * 1000; // 15 days

// ─── Capability Detection ─────────────────────────────────
const SW_AI_SUPPORT = {
	cache: !!self.caches,
	indexedDB: !!self.indexedDB,
	notification: !!self.registration?.showNotification,
	permissions: !!self.navigator?.permissions,
	compression: true,
	encryption: true
};

// ─── Middleware: Fetch Event Listener ─────────────────────
self.addEventListener('fetch', event => {
	event.respondWith(
		(async () => {
			const strategy = await aiDecisionEngine(event.request);

			try {
				if (strategy.loadFrom === 'cache') {
					const cached = await caches.match(event.request);
					if (cached) return cached;
				}

				const netRes = await fetch(event.request);
				if (strategy.checkUpdate) {
					const isStale = await isStaleContent(event.request, netRes);
					if (isStale) await updateCache(event.request, netRes.clone());
				}

				if (strategy.store === 'cache') await updateCache(event.request, netRes.clone());
				if (strategy.store === 'profile') await storeToProfile(event.request, netRes.clone());

				return netRes;
			} catch {
				if (event.request.mode === 'navigate') return caches.match('/offline.html');
				return new Response('Offline or network error', { status: 503 });
			}
		})()
	);
});

// ─── AI Decision Engine ───────────────────────────────────
async function aiDecisionEngine(request) {
	const url = new URL(request.url);
	const ext = url.pathname.split('.').pop();
	const fileType = classifyFileType(ext);
	const profile = await SW_AI_STORE.getProfileData(url.href);
	const netInfo = getNetworkInfo();
	const isOffline = !navigator.onLine;

	const fileMeta = {
		fileType,
		lastSeen: profile?.time || 0,
		changeRate: profile ? estimateChangeRate(profile) : 'unknown',
		sizeEstimate: profile?.contentLength || 0
	};

	let loadFrom = isOffline ? 'cache' : 'network';
	if (fileMeta.fileType === 'html' && netInfo.downlink < 1.5) loadFrom = 'cache';
	if (fileMeta.changeRate === 'low') loadFrom = 'cache';

	let store = 'none';
	if (['html', 'json'].includes(fileMeta.fileType)) store = 'cache';
	else if (!isOffline && fileMeta.sizeEstimate > 3000) store = 'profile';

	let checkUpdate = fileMeta.changeRate !== 'low';

	return { loadFrom, store, checkUpdate };
}

function classifyFileType(ext) {
	if (!ext) return 'html';
	if (['js', 'mjs'].includes(ext)) return 'script';
	if (['css'].includes(ext)) return 'style';
	if (['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp'].includes(ext)) return 'image';
	if (['html', 'htm'].includes(ext)) return 'html';
	if (['json'].includes(ext)) return 'json';
	return 'asset';
}

function getNetworkInfo() {
	const conn = navigator.connection || {};
	return {
		type: conn.type || 'unknown',
		effectiveType: conn.effectiveType || '4g',
		downlink: conn.downlink || 10
	};
}

function estimateChangeRate(profile) {
	const age = (Date.now() - profile.time) / (24 * 60 * 60 * 1000);
	if (age > 10) return 'high';
	if (age > 4) return 'medium';
	return 'low';
}

// ─── Caching & Stale Checker ──────────────────────────────
async function updateCache(req, res) {
	const cache = await caches.open(CACHE_NAME);
	await cache.put(req, res);
}

async function isStaleContent(req, newRes) {
	const cache = await caches.open(CACHE_NAME);
	const oldRes = await cache.match(req);
	if (!oldRes) return true;

	const oldTag = oldRes.headers.get('etag');
	const newTag = newRes.headers.get('etag');
	const oldDate = oldRes.headers.get('last-modified');
	const newDate = newRes.headers.get('last-modified');

	if (newTag && oldTag && newTag !== oldTag) return true;
	if (newDate && oldDate && new Date(newDate) > new Date(oldDate)) return true;
	return false;
}

// ─── Profile Store with Compress/Encrypt (Stub) ───────────
const SW_AI_STORE = {
	async storeProfileData(data) {
		const db = await openDB();
		const compressed = btoa(JSON.stringify(data)); // compression stub
		const encrypted = btoa(compressed); // encryption stub
		await db.put(PROFILE_STORE, { url: data.url, time: data.time, value: encrypted });
		await db.close();
	},

	async getProfileData(url) {
		const db = await openDB();
		const entry = await db.get(PROFILE_STORE, url);
		await db.close();
		if (!entry) return null;

		const decrypted = atob(entry.value);
		const decompressed = atob(decrypted);
		const parsed = JSON.parse(decompressed);

		if (Date.now() - parsed.time > DATA_MAX_AGE) return null;
		return parsed;
	}
};

function openDB() {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open('SW_AI_DB', 1);
		req.onupgradeneeded = e => {
			const db = e.target.result;
			if (!db.objectStoreNames.contains(PROFILE_STORE)) {
				db.createObjectStore(PROFILE_STORE, { keyPath: 'url' });
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

// ─── Push Notification Handler ────────────────────────────
self.addEventListener('push', event => {
	let data = {};
	try { data = event.data.json(); }
	catch { data = { title: 'Push', body: 'No data' }; }

	event.waitUntil(
		self.registration.showNotification(data.title, {
			body: data.body,
			icon: data.icon || '/default-icon.png'
		})
	);
});

// ─── Messaging Between Frontend and SW ────────────────────
self.addEventListener('message', event => {
	if (event.data?.type === 'GET_CAPABILITIES') {
		event.ports[0].postMessage(SW_AI_SUPPORT);
	}
});
