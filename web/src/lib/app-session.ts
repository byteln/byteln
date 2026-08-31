/** App-wide lock / clear — wired from VaultGate at startup. */

type AppSessionHandlers = {
	lock: () => Promise<void>;
	clearAll: () => Promise<void>;
};

let handlers: AppSessionHandlers | null = null;

export function registerAppSession(next: AppSessionHandlers): () => void {
	handlers = next;
	return () => {
		if (handlers === next) handlers = null;
	};
}

export async function lockApp(): Promise<void> {
	await handlers?.lock();
}

export async function clearAllLocal(): Promise<void> {
	await handlers?.clearAll();
}
