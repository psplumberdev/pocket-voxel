/** Stable PSP layout: both launch files live in the same VOXELMON folder.
 * Only those two files are installed; existing save files are never copied. */
import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const PSP_PACKAGE_FILES = ["voxelmon.vxpak", "EBOOT.PBP"] as const;
async function hash(path: string): Promise<string> {
  const sha = createHash("sha256");
  for await (const bytes of createReadStream(path)) sha.update(bytes);
  return sha.digest("hex");
}
export async function installPspPackage(source: string, destination: string): Promise<Record<string, string>> {
  // Fail before touching the installed game when either source is missing.
  for (const file of PSP_PACKAGE_FILES) await access(join(source, file));
  await mkdir(destination, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const file of PSP_PACKAGE_FILES) {
    const src = join(source, file), staged = join(destination, `${file}.installing`);
    hashes[file] = await hash(src);
    await copyFile(src, staged);
    if (await hash(staged) !== hashes[file]) throw new Error(`PSP copy verification failed: ${file}`);
  }
  // Asset pack first, executable last: never advertise a new launcher before
  // its verified asset file has arrived. Rename also leaves saves untouched.
  for (const file of PSP_PACKAGE_FILES) await rename(join(destination, `${file}.installing`), join(destination, file));
  for (const file of PSP_PACKAGE_FILES) {
    if (await hash(join(destination, file)) !== hashes[file]) throw new Error(`PSP installed hash mismatch: ${file}`);
  }
  return hashes;
}
