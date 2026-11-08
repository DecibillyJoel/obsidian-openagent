export const OA_IMAGE_MIMES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

// A source image in any supported format may be up to 10 MB (spec: 10 MB input limit).
export const OA_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

// A converted or internal PNG is capped at 64 MB. The same cap applies to the
// aggregate converted payload (spec: 64 MB internal and total PNG limit).
export const OA_MAX_PNG_BYTES = 64 * 1024 * 1024;
export const OA_MAX_TOTAL_IMAGE_BYTES = OA_MAX_PNG_BYTES;

export const OA_MAX_IMAGES = 8;
