#!/usr/bin/env node
/**
 * ABI Conformance Check
 *
 * Compares the Forge-compiled contract ABI artifacts against the frontend's
 * hand-written ABI definitions in config.js, index.html, and lp-vault.html.
 *
 * Run: node scripts/checkAbiConformance.js
 *
 * Exit code 0 = all ABIs match, exit code 1 = mismatch found.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'out');
const FRONTEND_DIR = path.join(ROOT, '..', 'frontend');

let hasMismatch = false;

function fail(msg) {
    console.error(`  ❌ MISMATCH: ${msg}`);
    hasMismatch = true;
}

function pass(msg) {
    console.log(`  ✅ ${msg}`);
}

// ========== 1. Check getVault tuple fields against Forge artifact ==========

function checkGetVaultAbi() {
    console.log('\n--- Checking getVault ABI ---');

    const artifact = require(path.join(OUT_DIR, 'VaultFacet.sol', 'VaultFacet.json'));
    const getVaultArtifact = artifact.abi.find(
        f => f.name === 'getVault' && f.type === 'function'
    );
    if (!getVaultArtifact) {
        fail('getVault not found in VaultFacet artifact');
        return;
    }

    const artifactFields = getVaultArtifact.outputs[0].components.map(c => ({
        name: c.name,
        type: c.type,
    }));

    // Check config.js RAW_ABIS.getVault
    const configPath = path.join(FRONTEND_DIR, 'js', 'config.js');
    const configSrc = fs.readFileSync(configPath, 'utf8');

    // Extract the getVault components block from config.js
    const configMatch = configSrc.match(
        /getVault:\s*\{[\s\S]*?components:\s*\[([\s\S]*?)\]\s*,\s*name:\s*''/
    );
    if (!configMatch) {
        fail('Could not extract getVault components from config.js');
    } else {
        const configFields = parseComponentFields(configMatch[1]);
        compareFields('config.js RAW_ABIS.getVault', configFields, artifactFields);
    }

    // Check index.html inline ABI
    const indexHtmlPath = path.join(FRONTEND_DIR, 'index.html');
    const indexHtmlSrc = fs.readFileSync(indexHtmlPath, 'utf8');
    const indexMatch = indexHtmlSrc.match(
        /name:\s*'getVault'[\s\S]*?components:\s*\[([\s\S]*?)\]\s*\}/
    );
    if (!indexMatch) {
        fail('Could not extract getVault components from index.html');
    } else {
        const indexFields = parseComponentFields(indexMatch[1]);
        compareFields('index.html getVault', indexFields, artifactFields);
    }

    // Check lp-vault.html inline ABI
    const lpVaultHtmlPath = path.join(FRONTEND_DIR, 'lp-vault.html');
    const lpVaultHtmlSrc = fs.readFileSync(lpVaultHtmlPath, 'utf8');
    // The components block ends with ] followed by } then ] then } then ,
    const lpVaultMatch = lpVaultHtmlSrc.match(
        /name:\s*'getVault'[\s\S]*?components:\s*\[([\s\S]*?)\]\s*\n\s*\}\s*\]/
    );
    if (!lpVaultMatch) {
        fail('Could not extract getVault components from lp-vault.html');
    } else {
        const lpFields = parseComponentFields(lpVaultMatch[1]);
        compareFields('lp-vault.html getVault', lpFields, artifactFields);
    }
}

// ========== 2. Check hub function signatures against Forge artifact ==========

function checkHubFunctionSigs() {
    console.log('\n--- Checking Hub function signatures ---');

    const vaultArtifact = require(path.join(OUT_DIR, 'VaultFacet.sol', 'VaultFacet.json'));
    const hubArtifact = require(path.join(OUT_DIR, 'wsXmrHub.sol', 'wsXmrHub.json'));

    // Collect all view/read function signatures from artifacts
    const artifactSigs = new Map();
    for (const abi of [vaultArtifact.abi, hubArtifact.abi]) {
        for (const func of abi.filter(f => f.type === 'function')) {
            const sig = `${func.name}(${func.inputs.map(i => i.type).join(',')})`;
            artifactSigs.set(func.name, sig);
        }
    }

    // Extract human-readable ABI from config.js
    const configPath = path.join(FRONTEND_DIR, 'js', 'config.js');
    const configSrc = fs.readFileSync(configPath, 'utf8');

    // Find the HUB_ABI array
    const hubAbiMatch = configSrc.match(/HUB_ABI\s*=\s*\[([\s\S]*?)\];/);
    if (!hubAbiMatch) {
        // Try alternate pattern (may not be named HUB_ABI)
        const altMatch = configSrc.match(/'function\s+(\w+)\s*\(([^)]*)\)/g);
        if (!altMatch) {
            fail('Could not extract hub ABI from config.js');
            return;
        }
    }

    // Extract all 'function name(args)' strings from config.js
    const funcPattern = /'function\s+(\w+)\s*\(([^)]*)\)/g;
    let match;
    const configFuncs = new Map();
    while ((match = funcPattern.exec(configSrc)) !== null) {
        const name = match[1];
        const args = match[2].trim();
        // Normalize: remove 'external', 'view', 'returns', etc. and just get arg types
        const argTypes = args
            .split(',')
            .map(a => a.trim().split(' ')[0]) // first word is the type
            .filter(t => t.length > 0);
        configFuncs.set(name, argTypes.join(','));
    }

    // Check key functions that should exist in both
    const keyFuncs = [
        'getVaultHealth',
        'getVaultDebt',
        'getMintCapacity',
        'getVaultCount',
        'getCoLPCapacity',
        'hasActiveVault',
    ];

    for (const funcName of keyFuncs) {
        if (!artifactSigs.has(funcName)) {
            fail(`${funcName} not found in contract artifacts`);
            continue;
        }
        if (!configFuncs.has(funcName)) {
            console.log(`  ℹ️  ${funcName} not in config.js hub ABI (may be unused in frontend)`);
            continue;
        }

        // Compare argument types
        const artifactArgs = artifactSigs.get(funcName)
            .replace(`${funcName}(`, '')
            .replace(')', '')
            .split(',')
            .filter(a => a.length > 0)
            .map(a => a.trim());

        const configArgs = configFuncs.get(funcName).split(',').filter(a => a.length > 0);

        if (artifactArgs.length !== configArgs.length) {
            fail(`${funcName}: arg count mismatch (artifact: ${artifactArgs.length}, config: ${configArgs.length})`);
        } else {
            let argsMatch = true;
            for (let i = 0; i < artifactArgs.length; i++) {
                if (artifactArgs[i] !== configArgs[i]) {
                    fail(`${funcName}: arg ${i} type mismatch (artifact: ${artifactArgs[i]}, config: ${configArgs[i]})`);
                    argsMatch = false;
                }
            }
            if (argsMatch) {
                pass(`${funcName}(${configArgs.join(',')}) matches artifact`);
            }
        }
    }

    // Also check getVault separately since it's in RAW_ABIS, not the string ABI
    if (!configFuncs.has('getVault')) {
        // getVault is in RAW_ABIS, checked in checkGetVaultAbi() above
        pass('getVault is in RAW_ABIS (checked separately)');
    }
}

// ========== 3. Check for stale/non-existent functions in frontend ABI ==========

function checkStaleFunctions() {
    console.log('\n--- Checking for stale functions in frontend ABI ---');

    const configPath = path.join(FRONTEND_DIR, 'js', 'config.js');
    const configSrc = fs.readFileSync(configPath, 'utf8');

    // Known functions that were removed from the contract
    const staleFunctions = [
        'setMintReadyBond',
        'mintReadyBond',
    ];

    for (const stale of staleFunctions) {
        if (configSrc.includes(stale)) {
            fail(`config.js still references removed function/field '${stale}'`);
        } else {
            pass(`'${stale}' not found in config.js`);
        }
    }

    // Check index.html and lp-vault.html too
    for (const htmlFile of ['index.html', 'lp-vault.html']) {
        const htmlPath = path.join(FRONTEND_DIR, htmlFile);
        const htmlSrc = fs.readFileSync(htmlPath, 'utf8');
        for (const stale of staleFunctions) {
            if (htmlSrc.includes(stale)) {
                fail(`${htmlFile} still references removed function/field '${stale}'`);
            }
        }
    }
}

// ========== Helpers ==========

function parseComponentFields(src) {
    const fields = [];
    const pattern = /\{\s*name:\s*['"]([^'"]+)['"]\s*,\s*type:\s*['"]([^'"]+)['"]\s*\}/g;
    let match;
    while ((match = pattern.exec(src)) !== null) {
        fields.push({ name: match[1], type: match[2] });
    }
    return fields;
}

function compareFields(label, frontendFields, artifactFields) {
    if (frontendFields.length !== artifactFields.length) {
        fail(`${label}: field count mismatch (frontend: ${frontendFields.length}, artifact: ${artifactFields.length})`);
        // Show the extra/missing fields
        const frontendNames = frontendFields.map(f => f.name);
        const artifactNames = artifactFields.map(f => f.name);
        const missing = artifactNames.filter(n => !frontendNames.includes(n));
        const extra = frontendNames.filter(n => !artifactNames.includes(n));
        if (missing.length) console.error(`       Missing from frontend: ${missing.join(', ')}`);
        if (extra.length) console.error(`       Extra in frontend: ${extra.join(', ')}`);
        return;
    }

    let allMatch = true;
    for (let i = 0; i < artifactFields.length; i++) {
        if (frontendFields[i].name !== artifactFields[i].name) {
            fail(`${label}: field ${i} name mismatch (frontend: '${frontendFields[i].name}', artifact: '${artifactFields[i].name}')`);
            allMatch = false;
        } else if (frontendFields[i].type !== artifactFields[i].type) {
            fail(`${label}: field '${frontendFields[i].name}' type mismatch (frontend: '${frontendFields[i].type}', artifact: '${artifactFields[i].type}')`);
            allMatch = false;
        }
    }
    if (allMatch) {
        pass(`${label}: all ${artifactFields.length} fields match artifact`);
    }
}

// ========== Main ==========

async function main() {
    console.log('=== ABI Conformance Check ===');
    console.log(`Contract artifacts: ${OUT_DIR}`);
    console.log(`Frontend source:    ${FRONTEND_DIR}`);

    if (!fs.existsSync(OUT_DIR)) {
        console.error('Forge out/ directory not found. Run "forge build" first.');
        process.exit(1);
    }

    checkGetVaultAbi();
    checkHubFunctionSigs();
    checkStaleFunctions();

    console.log('\n=== Summary ===');
    if (hasMismatch) {
        console.error('❌ ABI mismatches detected! Fix the frontend ABI definitions to match contract artifacts.');
        process.exit(1);
    } else {
        console.log('✅ All ABI definitions are consistent with contract artifacts.');
        process.exit(0);
    }
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
