import { DEFAULT_SETTINGS, type PluginSettings } from "../../settings";
import type { ToolDef } from "../../types";
import { webFetchTool } from "./fetch";
import { webReadTool } from "./read";
import { webResearchTool } from "./research";

export function webTools(getSettings: () => PluginSettings = () => DEFAULT_SETTINGS): ToolDef[] {
	return [webFetchTool(), webReadTool(), webResearchTool(getSettings)];
}
