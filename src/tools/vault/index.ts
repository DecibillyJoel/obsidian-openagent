import type { App } from "obsidian";
import type { UndoBuffer } from "../../consent/undo";
import type { ToolDef } from "../../types";
import { appendTool } from "./append";
import { openAgentVaultDeleteTool } from "./delete";
import { editTool } from "./edit";
import { openAgentVaultImageTool } from "./image";
import { linksTool } from "./links";
import { listTool } from "./list";
import { metadataTool } from "./metadata";
import { openAgentVaultMoveTool } from "./move";
import { readTool } from "./read";
import { openAgentVaultRenameTool } from "./rename";
import { searchTool } from "./search";
import { writeTool } from "./write";

export interface VaultToolDeps {
	undo: UndoBuffer;
}

export function vaultTools(app: App, deps: VaultToolDeps): ToolDef[] {
	return [
		listTool(app),
		readTool(app),
		openAgentVaultImageTool(app),
		searchTool(app),
		metadataTool(app),
		linksTool(app),
		writeTool(app, deps.undo),
		appendTool(app, deps.undo),
		editTool(app, deps.undo),
		openAgentVaultRenameTool(app, deps.undo),
		openAgentVaultDeleteTool(app, deps.undo),
		openAgentVaultMoveTool(app, deps.undo),
	];
}
