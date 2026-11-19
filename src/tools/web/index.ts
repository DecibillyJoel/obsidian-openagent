import type { ToolDef } from "../../types";
import { webFetchTool } from "./fetch";
import { webReadTool } from "./read";

export function webTools(): ToolDef[] {
	return [webFetchTool(), webReadTool()];
}
