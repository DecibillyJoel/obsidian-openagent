import { describe, expect, it } from "vitest";
import manifest from "../manifest.json";
import pkg from "../package.json";
import versions from "../versions.json";

describe("release version", () => {
	it("keeps manifest, package, and versions in agreement", () => {
		expect(manifest.version).toBe("0.1.3");
		expect(manifest.version).toBe(pkg.version);
		expect((versions as Record<string, string>)[manifest.version]).toBe(manifest.minAppVersion);
	});
});
