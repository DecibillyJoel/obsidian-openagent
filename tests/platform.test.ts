import { describe, expect, it } from "vitest";
import { isMobile } from "../src/platform";
import { setMobileMode } from "./setup";

describe("platform flags", () => {
	it("follows the platform flag", () => {
		setMobileMode(false);
		expect(isMobile()).toBe(false);
		setMobileMode(true);
		expect(isMobile()).toBe(true);
		setMobileMode(false);
	});
});
