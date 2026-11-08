export interface OaImageDimensions {
	width: number;
	height: number;
}

function oaUint16BE(bytes: Uint8Array, offset: number): number {
	return (bytes[offset] << 8) | bytes[offset + 1];
}

function oaUint16LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8);
}

function oaUint24LE(bytes: Uint8Array, offset: number): number {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function oaUint32BE(bytes: Uint8Array, offset: number): number {
	return (
		(bytes[offset] << 24) |
		(bytes[offset + 1] << 16) |
		(bytes[offset + 2] << 8) |
		bytes[offset + 3]
	);
}

/** Reads the pixel dimensions of a PNG, GIF, WebP, or JPEG payload from its header. */
export function oaSniffImageDimensions(bytes: Uint8Array): OaImageDimensions | null {
	if (bytes.length < 4) return null;

	// PNG: \x89 P N G signature, then the IHDR width and height as big-endian uint32.
	if (bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71) {
		if (bytes.length < 24) return null;
		if (bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return null;
		return { width: oaUint32BE(bytes, 16), height: oaUint32BE(bytes, 20) };
	}

	// GIF: "GIF", logical screen width/height little-endian uint16 at offsets 6 and 8.
	if (bytes[0] === 71 && bytes[1] === 73 && bytes[2] === 70) {
		if (bytes.length < 10) return null;
		return { width: oaUint16LE(bytes, 6), height: oaUint16LE(bytes, 8) };
	}

	// WebP: RIFF container with a WEBP form type.
	if (
		bytes.length >= 12 &&
		bytes[0] === 82 &&
		bytes[1] === 73 &&
		bytes[2] === 70 &&
		bytes[3] === 70 &&
		bytes[8] === 87 &&
		bytes[9] === 69 &&
		bytes[10] === 66 &&
		bytes[11] === 80
	) {
		const fourCC = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
		let dimensions: OaImageDimensions | null = null;
		if (fourCC === "VP8X" && bytes.length >= 30) {
			dimensions = { width: 1 + oaUint24LE(bytes, 24), height: 1 + oaUint24LE(bytes, 27) };
		} else if (fourCC === "VP8 " && bytes.length >= 30) {
			dimensions = {
				width: oaUint16LE(bytes, 26) & 0x3fff,
				height: oaUint16LE(bytes, 28) & 0x3fff,
			};
		} else if (fourCC === "VP8L" && bytes.length >= 25) {
			const b0 = bytes[21];
			const b1 = bytes[22];
			const b2 = bytes[23];
			const b3 = bytes[24];
			dimensions = {
				width: 1 + ((b0 | (b1 << 8)) & 0x3fff),
				height: 1 + (((b1 >> 6) | (b2 << 2) | (b3 << 10)) & 0x3fff),
			};
		}
		return dimensions;
	}

	// JPEG: SOI marker, then scan segments for a start-of-frame marker.
	if (bytes[0] === 0xff && bytes[1] === 0xd8) {
		let offset = 2;
		while (offset + 9 < bytes.length) {
			if (bytes[offset] !== 0xff) {
				offset++;
				continue;
			}
			const marker = bytes[offset + 1];
			if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
				offset += 2;
				continue;
			}
			if (marker === 0xd9 || marker === 0xda) break;
			const length = oaUint16BE(bytes, offset + 2);
			if (length < 2) break;
			const isStartOfFrame =
				marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
			if (isStartOfFrame) {
				return { height: oaUint16BE(bytes, offset + 5), width: oaUint16BE(bytes, offset + 7) };
			}
			offset += 2 + length;
		}
	}

	return null;
}
