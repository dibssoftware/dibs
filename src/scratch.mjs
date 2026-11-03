// dibs setup scratch: a capped APFS volume for build output, so a build that
// runs away fills its own space instead of the disk every agent shares. Making
// a volume takes an admin password, so dibs never does it: it prints the
// commands for a person to run once, and --check says how full the volume is.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { OS } from './platform.mjs';
import { bytes, gb, die } from './util.mjs';

const NAME = 'DibsScratch';
// DIBS_SCRATCH points --check somewhere else, for tests.
const VOLUME = process.env.DIBS_SCRATCH || `/Volumes/${NAME}`;
// Room for DerivedData of a few projects plus test output, on a 256 GB Mac.
const SIZE = '40G';

// The APFS container the data volume lives in: the new volume shares its free space.
function container() {
  try { return execFileSync('diskutil', ['info', '/System/Volumes/Data'], { encoding: 'utf8' }).match(/APFS Container:\s+(disk\d+)/)?.[1] || null; }
  catch { return null; }
}

export function setup(args, o) {
  if (args[0] !== 'scratch') die('setup what? dibs setup scratch [--size 40G] [--check]');
  if (o.check) return check();
  if (OS !== 'macos') die('dibs setup scratch makes an APFS volume with a quota, which only macOS has. Your command did nothing.');
  const quota = `${Math.max(1, Math.round(bytes(o.size || SIZE) / 1024 ** 3))}g`;
  const disk = container() || '<container: see diskutil apfs list>';
  console.log(`A scratch volume capped at ${quota.toUpperCase()}. dibs doesn't run any of this; it needs an admin password once:

  sudo diskutil apfs addVolume ${disk} APFS ${NAME} -quota ${quota}
  sudo chown "$USER" ${VOLUME}
  touch ${VOLUME}/.metadata_never_index
  mkdir -p ${VOLUME}/DerivedData ${VOLUME}/tmp

It shares free space with the rest of ${disk} but stops at ${quota.toUpperCase()}: a runaway build gets "disk full"
on its own volume instead of filling the disk every agent uses. .metadata_never_index keeps Spotlight off it.

Point jobs at it:
  dibs run xcode-build -- xcodebuild ... -derivedDataPath ${VOLUME}/DerivedData
  dibs run test -- env TMPDIR=${VOLUME}/tmp npm test
A project's first build in a new DerivedData folder is a full rebuild.

Check it: dibs setup scratch --check    Remove it: sudo diskutil apfs deleteVolume ${NAME}`);
}

// Exit 1 when there's no volume, so a script can ask "is it set up?".
function check() {
  let st;
  try { st = fs.statSync(VOLUME); } catch {
    console.log(`no scratch volume at ${VOLUME}. Set one up: dibs setup scratch`);
    process.exit(1);
  }
  if (st.dev === fs.statSync(path.dirname(VOLUME)).dev) {
    console.log(`${VOLUME} is a plain folder, not its own volume, so nothing caps it. Set one up: dibs setup scratch`);
    process.exit(1);
  }
  const f = fs.statfsSync(VOLUME);
  const total = f.blocks * f.bsize, free = f.bavail * f.bsize;
  console.log(`scratch volume ${VOLUME}: ${gb(total - free)} used of ${gb(total)}, ${gb(free)} free`);
}
