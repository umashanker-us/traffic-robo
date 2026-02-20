/**
 * Electron Builder Configuration for GA4 Traffic Robo v2.4
 * 
 * LOW PRIORITY: Simplified packaging for distribution
 * 
 * Build commands:
 *   npm run build:win      → Windows .exe installer
 *   npm run build:mac      → macOS .dmg
 *   npm run build:linux    → Linux .AppImage + .deb
 *   npm run build:all      → All platforms
 *   npm run build:portable → Windows portable (no installer)
 * 
 * Prerequisites:
 *   npm install --save-dev electron-builder
 */

module.exports = {
    appId: "com.ga4trafficRobo.app",
    productName: "GA4 Traffic Robo",
    copyright: "Copyright © 2026 Uma Shankar",

    directories: {
        output: "dist",
        buildResources: "build"
    },

    files: [
        "src/**/*",
        "extensions/**/*",
        "package.json",
        "!src/test*.js",
        "!tests/**",
        "!jest.config.js",
        "!coverage/**",
        "!node_modules/.cache/**"
    ],

    extraResources: [
        {
            from: "data",
            to: "data",
            filter: ["**/*"]
        }
    ],

    // ===== Windows =====
    win: {
        target: [
            {
                target: "nsis",
                arch: ["x64"]
            },
            {
                target: "portable",
                arch: ["x64"]
            }
        ],
        icon: "build/icon.ico",
        artifactName: "${productName}-${version}-Setup-${arch}.${ext}"
    },

    nsis: {
        oneClick: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: true,
        createStartMenuShortcut: true,
        shortcutName: "GA4 Traffic Robo",
        installerIcon: "build/icon.ico",
        uninstallerIcon: "build/icon.ico",
        installerHeaderIcon: "build/icon.ico",
        perMachine: false,
        license: "LICENSE",
    },

    portable: {
        artifactName: "${productName}-${version}-Portable.${ext}"
    },

    // ===== macOS =====
    mac: {
        target: ["dmg", "zip"],
        icon: "build/icon.icns",
        category: "public.app-category.developer-tools",
        artifactName: "${productName}-${version}-macOS.${ext}",
        hardenedRuntime: false,
        gatekeeperAssess: false,
    },

    dmg: {
        title: "${productName} ${version}",
        contents: [
            { x: 130, y: 220 },
            { x: 410, y: 220, type: "link", path: "/Applications" }
        ]
    },

    // ===== Linux =====
    linux: {
        target: ["AppImage", "deb"],
        icon: "build/icons",
        category: "Development",
        artifactName: "${productName}-${version}-${arch}.${ext}",
        maintainer: "Uma Shankar",
        description: "GA4 Compatible Traffic Automation Tool with Realistic User Behavior Simulation"
    },

    appImage: {
        artifactName: "${productName}-${version}.${ext}"
    },

    deb: {
        depends: [
            "gconf2", "gconf-service", "libnotify4", "libappindicator1",
            "libxtst6", "libnss3", "libxss1"
        ]
    },

    // ===== Auto Update =====
    // Uncomment if using GitHub releases for auto-update
    // publish: {
    //     provider: "github",
    //     owner: "your-github-username",
    //     repo: "ga4-traffic-robo"
    // },

    // ===== Playwright Browser =====
    // Note: Playwright Chromium is NOT bundled — user must run:
    //   npx playwright install chromium
    // after installation. Consider adding a first-run check.
    afterPack: async function(context) {
        console.log("✅ Build complete! Remember: Users must run 'npx playwright install chromium' after first install.");
    }
};
