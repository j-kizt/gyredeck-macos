import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * One palette for the whole app (#376): a colour is named once, as a token in foundation.css's
 * :root, and everywhere else uses the token, so a screen cannot drift from the rest by picking
 * a shade of its own. No page is opened: this reads the source.
 */

const SRC = new URL("../src/", import.meta.url);
const HEX = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})(?![0-9a-z_-])/gi;

const files = (dir: URL, ext: string): URL[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(new URL(`${entry.name}/`, dir), ext) : entry.name.endsWith(ext) ? [new URL(entry.name, dir)] : []);

const hexes = (source: string) =>
  source.split("\n").flatMap((line, index) => (line.match(HEX) ?? []).map((hex) => `${index + 1}: ${hex}`));

test("no stylesheet but foundation.css spells out a hex colour", () => {
  const sheets = files(new URL("styles/", SRC), ".css").filter((file) => !file.pathname.endsWith("/foundation.css"));
  expect(sheets.length, "premise: the stylesheets are found").toBeGreaterThan(5);
  // Comments are blanked line for line, so an issue number (#277) is not read as a colour.
  const found = Object.fromEntries(sheets.map((file) => [
    decodeURIComponent(file.pathname.split("/").pop()!),
    hexes(readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "))),
  ]));
  expect(Object.fromEntries(Object.entries(found).filter(([, lines]) => lines.length > 0))).toEqual({});
});

test("no component styles with a hex colour of its own", () => {
  const components = files(SRC, ".tsx");
  expect(components.length, "premise: the components are found").toBeGreaterThan(10);
  // A hex that opens a string is a colour; one inside prose, such as "(#199)", is not.
  const found = Object.fromEntries(components.map((file) => [
    decodeURIComponent(file.pathname.slice(SRC.pathname.length)),
    readFileSync(file, "utf8").split("\n").flatMap((line, index) =>
      /["'`]\s*#[0-9a-f]{3,8}(?![0-9a-z_-])/i.test(line) ? [`${index + 1}: ${line.trim()}`] : []),
  ]));
  expect(Object.fromEntries(Object.entries(found).filter(([, lines]) => lines.length > 0))).toEqual({});
});
