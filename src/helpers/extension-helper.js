/**
 * SimilarWeb Extension Helper
 * 
 * This script helps locate and copy the SimilarWeb extension
 * from Chrome's extension directory.
 * 
 * Run with: node src/helpers/extension-helper.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Known SimilarWeb extension IDs (may vary)
const SIMILARWEB_IDS = [
    'fijplnnfmbcbdbdofpelabheebchllda',  // SimilarWeb main
    'gijpiebnodpmcjfhnclccbhjbifhmopi',  // Alternative ID
];

function getChromePath() {
    const platform = os.platform();
    const home = os.homedir();
    
    switch (platform) {
        case 'win32':
            return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data', 'Default', 'Extensions');
        case 'darwin':
            return path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'Default', 'Extensions');
        case 'linux':
            return path.join(home, '.config', 'google-chrome', 'Default', 'Extensions');
        default:
            return null;
    }
}

function findSimilarWebExtension() {
    const extensionsPath = getChromePath();
    
    if (!extensionsPath) {
        console.log('❌ Unsupported platform');
        return null;
    }
    
    console.log(`\n📁 Chrome Extensions Path: ${extensionsPath}\n`);
    
    if (!fs.existsSync(extensionsPath)) {
        console.log('❌ Chrome extensions directory not found');
        console.log('   Make sure Chrome is installed and you have extensions installed');
        return null;
    }
    
    // Look for known SimilarWeb IDs
    for (const id of SIMILARWEB_IDS) {
        const extPath = path.join(extensionsPath, id);
        if (fs.existsSync(extPath)) {
            console.log(`✅ Found SimilarWeb extension: ${id}`);
            
            // Get the latest version folder
            const versions = fs.readdirSync(extPath).filter(f => {
                return fs.statSync(path.join(extPath, f)).isDirectory();
            });
            
            if (versions.length > 0) {
                // Sort to get latest version
                versions.sort().reverse();
                const latestVersion = versions[0];
                const fullPath = path.join(extPath, latestVersion);
                
                console.log(`   Version: ${latestVersion}`);
                console.log(`   Full Path: ${fullPath}`);
                
                // Verify manifest exists
                const manifestPath = path.join(fullPath, 'manifest.json');
                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        console.log(`   Name: ${manifest.name}`);
                        console.log(`   Manifest Version: ${manifest.version}`);
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
                
                return fullPath;
            }
        }
    }
    
    // If not found by known IDs, list all extensions
    console.log('\n⚠️ SimilarWeb not found by known IDs. Listing all extensions:\n');
    
    try {
        const extensions = fs.readdirSync(extensionsPath);
        
        for (const extId of extensions) {
            const extPath = path.join(extensionsPath, extId);
            if (!fs.statSync(extPath).isDirectory()) continue;
            
            const versions = fs.readdirSync(extPath).filter(f => {
                const fPath = path.join(extPath, f);
                return fs.existsSync(fPath) && fs.statSync(fPath).isDirectory();
            });
            
            if (versions.length > 0) {
                const latestVersion = versions.sort().reverse()[0];
                const manifestPath = path.join(extPath, latestVersion, 'manifest.json');
                
                if (fs.existsSync(manifestPath)) {
                    try {
                        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                        const name = manifest.name || 'Unknown';
                        
                        if (name.toLowerCase().includes('similar')) {
                            console.log(`🎯 POSSIBLE MATCH: ${name}`);
                            console.log(`   ID: ${extId}`);
                            console.log(`   Path: ${path.join(extPath, latestVersion)}`);
                            console.log('');
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            }
        }
    } catch (e) {
        console.log(`Error reading extensions: ${e.message}`);
    }
    
    return null;
}

function copyExtension(sourcePath, destPath) {
    if (!fs.existsSync(sourcePath)) {
        console.log('❌ Source path does not exist');
        return false;
    }
    
    // Create destination directory
    if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
    }
    
    // Copy all files recursively
    const copyRecursive = (src, dest) => {
        const stat = fs.statSync(src);
        
        if (stat.isDirectory()) {
            if (!fs.existsSync(dest)) {
                fs.mkdirSync(dest);
            }
            
            fs.readdirSync(src).forEach(child => {
                copyRecursive(path.join(src, child), path.join(dest, child));
            });
        } else {
            fs.copyFileSync(src, dest);
        }
    };
    
    try {
        copyRecursive(sourcePath, destPath);
        console.log(`✅ Extension copied to: ${destPath}`);
        return true;
    } catch (e) {
        console.log(`❌ Error copying extension: ${e.message}`);
        return false;
    }
}

// Main
console.log('='.repeat(60));
console.log('SimilarWeb Extension Finder');
console.log('='.repeat(60));

const extPath = findSimilarWebExtension();

if (extPath) {
    console.log('\n📋 To use this extension in GA4 Traffic Robo:');
    console.log(`   1. Enable "Load Browser Extension" in the app`);
    console.log(`   2. Browse and select: ${extPath}`);
    console.log(`   3. Or copy to a convenient location first`);
    
    // Suggest copy location
    const suggestedDest = path.join(process.cwd(), 'extensions', 'similarweb');
    console.log(`\n💡 Suggested: Copy to ${suggestedDest}`);
    console.log(`   Run: node src/helpers/extension-helper.js --copy`);
} else {
    console.log('\n📋 Manual Steps:');
    console.log('   1. Open Chrome and install SimilarWeb extension');
    console.log('   2. Go to chrome://extensions/');
    console.log('   3. Enable Developer Mode');
    console.log('   4. Find SimilarWeb and note the ID');
    console.log('   5. Navigate to the extension folder shown above');
    console.log('   6. Use that path in GA4 Traffic Robo');
}

// Handle --copy flag
if (process.argv.includes('--copy') && extPath) {
    const dest = path.join(process.cwd(), 'extensions', 'similarweb');
    console.log(`\n📦 Copying extension to: ${dest}`);
    copyExtension(extPath, dest);
}

console.log('\n' + '='.repeat(60));
