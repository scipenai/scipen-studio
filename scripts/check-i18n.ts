/**
 * @file check-i18n.ts - i18n translation validation script
 * @description Validates that all translation files have the same keys by comparing them
 *              against en-US.json as the template. Ensures consistency across locales.
 * @depends fs, path, url
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ====== Paths ======
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localesDir = path.join(__dirname, '../src/locales');

// ====== Types ======
interface TranslationObject {
  [key: string]: string | TranslationObject;
}

// ====== File Loading ======
function loadJson(filePath: string): TranslationObject {
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content);
}

// ====== Key Extraction ======
function getAllKeys(obj: TranslationObject, prefix = ''): string[] {
  const keys: string[] = [];
  
  for (const key of Object.keys(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    
    if (typeof value === 'object' && value !== null) {
      keys.push(...getAllKeys(value as TranslationObject, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  
  return keys;
}

// ====== Validation ======
function checkRecursively(
  target: TranslationObject,
  template: TranslationObject,
  targetName: string,
  templateName: string,
  path = ''
): string[] {
  const errors: string[] = [];
  
  for (const key in template) {
    const currentPath = path ? `${path}.${key}` : key;
    
    if (!(key in target)) {
      errors.push(`Missing key in ${targetName}: ${currentPath}`);
      continue;
    }
    
    const templateValue = template[key];
    const targetValue = target[key];
    
    if (typeof templateValue === 'object' && templateValue !== null) {
      if (typeof targetValue !== 'object' || targetValue === null) {
        errors.push(`Type mismatch in ${targetName}: ${currentPath} should be an object`);
      } else {
        errors.push(
          ...checkRecursively(
            targetValue as TranslationObject,
            templateValue as TranslationObject,
            targetName,
            templateName,
            currentPath
          )
        );
      }
    } else if (typeof targetValue === 'object') {
      errors.push(`Type mismatch in ${targetName}: ${currentPath} should be a string`);
    }
  }
  
  for (const key in target) {
    const currentPath = path ? `${path}.${key}` : key;
    if (!(key in template)) {
      errors.push(`Extra key in ${targetName} (not in ${templateName}): ${currentPath}`);
    }
  }
  
  return errors;
}

// ====== Main ======
async function main() {
  console.log('Checking i18n translations...\n');
  
  const files = fs.readdirSync(localesDir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({
      name: f,
      path: path.join(localesDir, f)
    }));
  
  if (files.length === 0) {
    console.error('No translation files found!');
    process.exit(1);
  }
  
  const templateFile = files.find(f => f.name === 'en-US.json');
  if (!templateFile) {
    console.error('Template file en-US.json not found!');
    process.exit(1);
  }
  
  const template = loadJson(templateFile.path);
  const templateKeys = getAllKeys(template);
  
  console.log(`Template: ${templateFile.name} (${templateKeys.length} keys)\n`);
  
  let hasErrors = false;
  
  for (const file of files) {
    if (file.name === templateFile.name) continue;
    
    const target = loadJson(file.path);
    const targetKeys = getAllKeys(target);
    
    console.log(`Checking: ${file.name} (${targetKeys.length} keys)`);
    
    const errors = checkRecursively(target, template, file.name, templateFile.name);
    
    if (errors.length > 0) {
      hasErrors = true;
      console.log(`  ❌ ${errors.length} issues found:`);
      errors.forEach(e => console.log(`     - ${e}`));
    } else {
      console.log(`  ✓ All keys match`);
    }
    console.log();
  }
  
  if (hasErrors) {
    console.log('\n❌ i18n check failed!');
    process.exit(1);
  } else {
    console.log('\n✓ All translation files are in sync!');
  }
}

main().catch(console.error);

