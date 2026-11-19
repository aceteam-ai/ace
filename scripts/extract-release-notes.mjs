#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("Expected a stable version");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const lines = changelog.split("\n");
const start = lines.findIndex((line) => line.startsWith(`## ${version} - `));
if (start < 0) throw new Error(`Missing CHANGELOG section for ${version}`);
let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
if (end < 0) end = lines.length;
const notes = lines.slice(start + 1, end).join("\n").trim();
if (!notes) throw new Error(`Empty CHANGELOG section for ${version}`);
writeFileSync("release-notes.md", `${notes}\n`);
