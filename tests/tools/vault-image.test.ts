import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class MockTFile {
		path: string;
		stat = { size: 0 };
		constructor(path: string) {
			this.path = path;
		}
	}
	class MockTFolder {
		path: string;
		children: unknown[] = [];
		constructor(path: string) {
			this.path = path;
		}
	}
	return { MockTFile, MockTFolder };
});

vi.mock("obsidian", () => ({
	TFile: mocks.MockTFile,
	TFolder: mocks.MockTFolder,
	normalizePath: (path: string) => path,
}));

import { OA_MAX_IMAGE_BYTES } from "../../src/images/attachments";
import { openAgentVaultImageTool } from "../../src/tools/vault/image";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_BYTES = new Uint8Array([
	0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]);

interface FileSpec {
	path: string;
	size?: number;
	bytes?: Uint8Array;
}

interface AppOptions {
	files: FileSpec[];
	/** Wikilink target -> resolved file path. An absent target stays unresolved. */
	links?: Record<string, string>;
}

function makeApp(options: AppOptions) {
	const { files, links = {} } = options;
	const tfiles = files.map((spec) => {
		const file = new mocks.MockTFile(spec.path);
		const bytes = spec.bytes ?? PNG_BYTES;
		file.stat.size = spec.size ?? bytes.length;
		return { file, bytes };
	});
	const tfileByPath = new Map(tfiles.map(({ file }) => [file.path, file]));
	const bytesByPath = new Map(tfiles.map(({ file, bytes }) => [file.path, bytes]));
	return {
		vault: {
			getAbstractFileByPath: (path: string) => tfileByPath.get(path) ?? null,
			readBinary: async (file: { path: string }) => bytesByPath.get(file.path),
		},
		metadataCache: {
			getFirstLinkpathDest: (target: string) => tfileByPath.get(links[target] ?? "") ?? null,
		},
	};
}

async function runImage(app: unknown, path: string) {
	return openAgentVaultImageTool(app as never).run({ path }, {} as never);
}

describe("openAgentVaultImageTool metadata", () => {
	it("declares the spec name, category, and schema", () => {
		const tool = openAgentVaultImageTool(makeApp({ files: [] }) as never);
		expect(tool.name).toBe("vault_image");
		expect(tool.category).toBe("vault_read");
		expect(tool.mutates).toBe(false);
		expect(tool.schema.required).toEqual(["path"]);
		expect(tool.schema.additionalProperties).toBe(false);
		expect(tool.schema.properties.path.type).toBe("string");
	});
});

describe("openAgentVaultImageTool resolution", () => {
	it("returns the display payload for a direct vault path", async () => {
		const app = makeApp({ files: [{ path: "Nora Portrait.png" }] });
		const result = await runImage(app, "Nora Portrait.png");
		expect(result.ok).toBe(true);
		expect(result.value).toEqual({
			path: "Nora Portrait.png",
			displayInChat: true,
			markdownEmbed: "![[Nora Portrait.png]]",
			mimeType: "image/png",
			size: PNG_BYTES.length,
		});
	});

	it("resolves a linked image and returns the resolved vault path", async () => {
		const app = makeApp({
			files: [{ path: "Assets/portrait.webp", bytes: WEBP_BYTES }],
			links: { portrait: "Assets/portrait.webp" },
		});
		const result = await runImage(app, "[[portrait]]");
		expect(result.ok).toBe(true);
		const value = result.value as { path: string; markdownEmbed: string; mimeType: string };
		expect(value.path).toBe("Assets/portrait.webp");
		expect(value.markdownEmbed).toBe("![[Assets/portrait.webp]]");
		expect(value.mimeType).toBe("image/webp");
	});

	it("strips embed syntax and takes the part before the alias", async () => {
		const app = makeApp({ files: [{ path: "Nora Portrait.png" }] });
		for (const input of ["![[Nora Portrait.png]]", "[[Nora Portrait.png|Nora]]", "[[Nora Portrait.png]]"]) {
			const result = await runImage(app, input);
			expect(result.ok).toBe(true);
			expect((result.value as { path: string }).path).toBe("Nora Portrait.png");
		}
	});
});

describe("openAgentVaultImageTool errors", () => {
	it("reports ImageNotFound for a missing file", async () => {
		const app = makeApp({ files: [] });
		const result = await runImage(app, "missing.png");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("ImageNotFound: missing.png");
	});

	it("reports UnsupportedImage for a known file that is not an image", async () => {
		const app = makeApp({ files: [{ path: "notes.txt" }] });
		const result = await runImage(app, "notes.txt");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("UnsupportedImage: notes.txt. Use PNG, JPEG, WebP, or GIF.");
	});

	it("reports ImageTooLarge for an empty image and one above the limit", async () => {
		const empty = await runImage(makeApp({ files: [{ path: "empty.png", size: 0 }] }), "empty.png");
		expect(empty.ok).toBe(false);
		expect(empty.error).toBe("ImageTooLarge: empty.png exceeds the 10 MB display limit.");

		const huge = await runImage(
			makeApp({ files: [{ path: "huge.png", size: OA_MAX_IMAGE_BYTES + 1 }] }),
			"huge.png",
		);
		expect(huge.ok).toBe(false);
		expect(huge.error).toBe("ImageTooLarge: huge.png exceeds the 10 MB display limit.");
	});

	it("reports InvalidImage when the bytes do not match the extension", async () => {
		const app = makeApp({ files: [{ path: "fake.png", bytes: JPEG_BYTES }] });
		const result = await runImage(app, "fake.png");
		expect(result.ok).toBe(false);
		expect(result.error).toBe("InvalidImage: fake.png");
	});
});
