import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

function getGitBranch() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: rootDir, encoding: 'utf-8' }).trim();
    return branch;
  } catch {
    return 'unknown';
  }
}

function bumpVersion(version, type = 'patch') {
  const parts = version.split('.').map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new Error(`Invalid semver version in package.json: "${version}"`);
  }
  let [major, minor, patch] = parts;
  if (type === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (type === 'minor') {
    minor += 1;
    patch = 0;
  } else {
    patch += 1;
  }
  return `${major}.${minor}.${patch}`;
}

const args = process.argv.slice(2);
const noBump = args.includes('--no-bump') || process.env.AUTO_BUMP === 'false';
const bumpType = args.includes('--major') ? 'major' : (args.includes('--minor') ? 'minor' : 'patch');

const currentBranch = getGitBranch();
const isMaster = currentBranch === 'master' || currentBranch === 'main';

const packageJsonPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
const currentVersion = pkg.version;

console.log('='.repeat(70));
console.log(`🌿 Current Git Branch: ${currentBranch}`);

let targetVersion = currentVersion;

if (isMaster && !noBump) {
  targetVersion = bumpVersion(currentVersion, bumpType);
  console.log(`🚀 MASTER RELEASE BUILD`);
  console.log(`📌 Auto-upgrading version: ${currentVersion} -> ${targetVersion} (${bumpType})`);
  pkg.version = targetVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
} else if (isMaster && noBump) {
  console.log(`🚀 MASTER BUILD (--no-bump specified)`);
  console.log(`📌 Preserving version: ${currentVersion}`);
} else {
  console.log(`🛠️ DEVELOPMENT / TEST BUILD (Branch: ${currentBranch})`);
  console.log(`ℹ️  Production version bumping only occurs on 'master' branch.`);
  console.log(`📌 Current version retained: ${currentVersion}`);
}
console.log('='.repeat(70));

console.log('\n📦 Step 1: Compiling extension...');
execSync('npm run compile', { cwd: rootDir, stdio: 'inherit' });

console.log('\n📦 Step 2: Packaging VSIX...');
const vsixName = 'intent-contract.vsix';
const versionedVsixName = `intent-contract-${targetVersion}.vsix`;

execSync(`npx vsce package --allow-missing-repository --out ${vsixName}`, { cwd: rootDir, stdio: 'inherit' });

// Also make a versioned copy
try {
  fs.copyFileSync(path.join(rootDir, vsixName), path.join(rootDir, versionedVsixName));
} catch (err) {
  console.warn(`Could not create versioned copy: ${err.message}`);
}

console.log('\n' + '='.repeat(70));
if (isMaster) {
  console.log(`✅ MASTER RELEASE VSIX CREATED:`);
  console.log(`   - File: ${vsixName} (v${targetVersion})`);
  console.log(`   - Versioned Backup: ${versionedVsixName}`);
  console.log('\n🌐 CERTIFIED FOR PRODUCTION UPLOAD TO:');
  console.log('   1. VS Code Marketplace:');
  console.log('      https://marketplace.visualstudio.com/manage/publishers/anilkumar4');
  console.log('   2. Open VSX Registry:');
  console.log('      https://open-vsx.org/user-settings/extensions/anilkumar4/intent-contract');
  console.log('\n💡 Remember to commit and tag the new version on master:');
  console.log(`   git commit -am "chore(release): v${targetVersion}"`);
  console.log(`   git tag v${targetVersion}`);
  console.log(`   git push origin master --tags`);
} else {
  console.log(`⚠️  DEV-TEST VSIX CREATED:`);
  console.log(`   - File: ${vsixName} (v${targetVersion} from branch '${currentBranch}')`);
  console.log('\n🚫 DO NOT UPLOAD THIS VSIX TO PRODUCTION MARKETPLACES:');
  console.log('   Only VSIX packages generated from the "master" branch are certified');
  console.log('   for upload to Visual Studio Marketplace and Open VSX.');
  console.log('   To create a production release:');
  console.log('     1. git checkout master');
  console.log(`     2. git merge ${currentBranch}`);
  console.log('     3. npm run build');
}
console.log('='.repeat(70));
