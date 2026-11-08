#!/usr/bin/env node
/**
 * Builds one ZIP package per example article of fixtures/article-packages/ (and fixtures/vi/article-packages/): the folder's article.md at the root and its assets/ files,
 * ready to upload on the import page (or to POST to the import endpoints).
 *
 * Plain Node, built-in modules only (zlib for deflate): no dependency. The archives are byte-for-byte the same on every run: entries
 * are sorted, the timestamp is fixed, nothing else varies. Only what the package reader accepts is written: regular files with
 * relative names, no folders, no extra fields, no ZIP64, no encryption.
 *
 *   node scripts/fixtures/build-article-zips.mjs <output folder>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { crc32 } from "./make-article-assets.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const FIXTURES = join(ROOT, "fixtures", "article-packages");
/** Packages whose text is not plain ASCII (a series name with accents); the guard allows such letters under fixtures/vi/ only. */
export const ACCENT_FIXTURES = join(ROOT, "fixtures", "vi", "article-packages");

/** 1980-01-01 00:00:00, the earliest time a ZIP can hold: a fixed stamp keeps the archive reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;
/** Bit 11: names are UTF-8. */
const UTF8_NAMES = 0x0800;
/** Made by "Unix", version 2.0, so the file mode below is read. */
const MADE_BY = (3 << 8) | 20;
/** A regular file with mode 0644. */
const REGULAR_FILE = (0o100644 << 16) >>> 0;

/**
 * The bytes of a ZIP archive with the given files, in the given order. Text and anything that gets smaller is deflated; the rest
 * (a PNG is already compressed) is stored.
 *
 * @param {ReadonlyArray<{ name: string, data: Buffer }>} files
 */
export function zipFiles(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(MADE_BY, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(REGULAR_FILE, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The files of one package folder: article.md first, then everything under assets/ in name order. */
function packageFiles(folder) {
  const files = [{ name: "article.md", data: readFileSync(join(folder, "article.md")) }];
  const walk = (directory, prefix) => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${entry}/`);
      else files.push({ name: `${prefix}${entry}`, data: readFileSync(path) });
    }
  };
  const assets = join(folder, "assets");
  if (existsSync(assets)) walk(assets, "assets/");
  return files;
}

/** The package folders of the fixtures (those with an article.md), by name. */
export function packageNames(root = FIXTURES) {
  return readdirSync(root)
    .filter((name) => existsSync(join(root, name, "article.md")))
    .sort();
}

/** The ZIP of every package folder: folder name to archive bytes. */
export function buildPackages(root = FIXTURES) {
  return new Map(packageNames(root).map((name) => [name, zipFiles(packageFiles(join(root, name)))]));
}

/** The ZIP of every package folder of both roots, the plain ASCII ones first. */
export function buildAllPackages() {
  return new Map([...buildPackages(FIXTURES), ...(existsSync(ACCENT_FIXTURES) ? buildPackages(ACCENT_FIXTURES) : [])]);
}

function main() {
  const out = process.argv[2];
  if (!out) {
    console.error("Usage: node scripts/fixtures/build-article-zips.mjs <output folder>");
    process.exit(2);
  }
  mkdirSync(resolve(out), { recursive: true });
  for (const [name, bytes] of buildAllPackages()) {
    writeFileSync(join(resolve(out), `${name}.zip`), bytes);
    console.log(`${name}.zip ${bytes.length} bytes`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
