import { type App, TFolder } from "obsidian";

export class NotAFolderError extends Error {
	readonly path: string;

	constructor(path: string) {
		super(`NotAFolder: ${path}`);
		this.name = "NotAFolderError";
		this.path = path;
	}
}

export async function openAgentEnsureFolderPath(app: App, path: string): Promise<string[]> {
	if (!path) return [];
	const created: string[] = [];
	let current = "";
	for (const part of path.split("/")) {
		current = current ? `${current}/${part}` : part;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing) {
			if (!(existing instanceof TFolder)) throw new NotAFolderError(current);
		} else {
			await app.vault.createFolder(current);
			created.push(current);
		}
	}
	return created;
}

export async function ensureParentFolder(app: App, path: string): Promise<string[]> {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return [];
	return openAgentEnsureFolderPath(app, path.slice(0, slash));
}
