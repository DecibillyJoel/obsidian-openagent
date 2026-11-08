const OA_ORDINAL_IMAGE_LABELS = [
	"first",
	"second",
	"third",
	"fourth",
	"fifth",
	"sixth",
	"seventh",
	"eighth",
	"ninth",
	"tenth",
];

// Reference names shorter than this are too generic to replace safely (Q43).
const OA_MIN_REFERENCE_NAME_LENGTH = 3;

export function oaOrdinalImageLabel(index: number): string {
	return `the ${OA_ORDINAL_IMAGE_LABELS[index] ?? `${index + 1}th`} image`;
}

export function oaEscapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replaces source-image names inside a prompt with their ordinal references. */
export function oaSanitizeImagePrompt(prompt: string, names: string[]): string {
	let result = prompt;
	names.forEach((name, index) => {
		if (!name || name === "conversation image") return;
		const base = name.replace(/^.*[\\/]/, "");
		for (const candidate of [name, base]) {
			if (candidate.length < OA_MIN_REFERENCE_NAME_LENGTH) continue;
			result = result.replace(new RegExp(oaEscapeRegExp(candidate), "gi"), oaOrdinalImageLabel(index));
		}
	});
	return result;
}
