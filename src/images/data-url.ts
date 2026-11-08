const DATA_URL_CHUNK_BYTES = 32768;
const DATA_URL_DECODE_MAX_BYTES = 96 * 1024 * 1024;

export function oaBufferToDataUrl(buf: Uint8Array | ArrayBuffer, mime: string): string {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += DATA_URL_CHUNK_BYTES) {
		const chunk = bytes.subarray(offset, offset + DATA_URL_CHUNK_BYTES);
		binary += String.fromCharCode(...chunk);
	}
	return `data:${mime};base64,${btoa(binary)}`;
}

export function oaBase64ToBuffer(base64: string): ArrayBuffer {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes.buffer;
}

export function oaDataUrlToBytes(dataUrl: string): Uint8Array | null {
	const match = typeof dataUrl === "string" ? /^data:[^,]*;base64,([\s\S]+)$/i.exec(dataUrl) : null;
	if (!match) return null;
	const base64 = match[1] ?? "";
	if (oaBase64ByteSize(base64) > DATA_URL_DECODE_MAX_BYTES) return null;
	try {
		return new Uint8Array(oaBase64ToBuffer(base64));
	} catch {
		return null;
	}
}

export function oaBase64ByteSize(base64: string): number {
	if (typeof base64 !== "string") return 0;
	const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
	return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
}
