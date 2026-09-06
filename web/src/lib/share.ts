import { encode } from 'uqr';

export type ShareInviteOpts = {
	url: string;
	pin?: string;
	/** Include QR PNG (link only — PIN never encoded in the image). */
	withQr?: boolean;
	/** Filename stem for QR download fallback. */
	qrFilename?: string;
};

export type ShareResult = 'shared' | 'copied' | 'downloaded' | 'cancelled';

/** Same invite copy used by clipboard + system share. */
export function inviteText(url: string, pin?: string, withQr = false): string {
	const linkLead = withQr
		? 'Open this link in your browser (or scan the QR):'
		: 'Open this link in your browser:';
	if (!pin) return `${linkLead}\n${url}`;
	return `${linkLead}\n${url}\n\nRoom PIN (enter separately — do not paste into the URL):\n${pin}`;
}

/** Rasterize a URL QR to PNG (modules match ShareQr / uqr defaults). */
export async function qrPngBlob(value: string, modulePx = 8): Promise<Blob> {
	const qr = encode(value, { ecc: 'M', boostEcc: true, border: 4 });
	const size = qr.size * modulePx;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas unavailable');
	ctx.fillStyle = '#fff';
	ctx.fillRect(0, 0, size, size);
	ctx.fillStyle = '#090B0D';
	for (let y = 0; y < qr.size; y++) {
		const row = qr.data[y];
		if (!row) continue;
		for (let x = 0; x < qr.size; x++) {
			if (row[x]) ctx.fillRect(x * modulePx, y * modulePx, modulePx, modulePx);
		}
	}
	return new Promise((resolve, reject) => {
		canvas.toBlob((blob) => {
			if (blob) resolve(blob);
			else reject(new Error('Failed to encode QR PNG'));
		}, 'image/png');
	});
}

function downloadBlob(blob: Blob, filename: string) {
	const href = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = href;
	a.download = filename;
	a.rel = 'noopener';
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(href);
}

function canShareFiles(files: File[]): boolean {
	try {
		return typeof navigator.canShare === 'function' && navigator.canShare({ files });
	} catch {
		return false;
	}
}

/**
 * Prefer Web Share (QR file + text when possible), else clipboard,
 * and download QR PNG when file share is unavailable but withQr was requested.
 *
 * When sharing a QR file, omit the separate `url` field — many chat apps keep
 * only the image and drop message text if both `files` and `url` are set.
 */
export async function shareInvite(opts: ShareInviteOpts): Promise<ShareResult> {
	const text = inviteText(opts.url, opts.pin, opts.withQr === true);
	const title = 'Secure line invite';
	let qrFile: File | null = null;

	if (opts.withQr) {
		const blob = await qrPngBlob(opts.url);
		qrFile = new File([blob], opts.qrFilename ?? 'byteln-qr.png', { type: 'image/png' });
	}

	if (typeof navigator.share === 'function') {
		try {
			if (qrFile && canShareFiles([qrFile])) {
				await navigator.share({
					title,
					text,
					files: [qrFile]
				});
				return 'shared';
			}
			await navigator.share({ title, text, url: opts.url });
			if (qrFile) {
				downloadBlob(qrFile, qrFile.name);
				return 'downloaded';
			}
			return 'shared';
		} catch (e) {
			if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled';
			// Fall through to clipboard / download.
		}
	}

	await navigator.clipboard.writeText(text);
	if (qrFile) {
		downloadBlob(qrFile, qrFile.name);
		return 'downloaded';
	}
	return 'copied';
}
