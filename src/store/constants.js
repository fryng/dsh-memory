/**
 * Shared constants that both the config layer and the storage layer need.
 *
 * They live in their own module so `store/*` never has to import `config.js`
 * (which pulls in the validators) and `config.js` never has to import the store.
 */

/** Memory levels. See `config.js` for the reasoning behind the set. */
export const LEVELS = ['fact', 'preference', 'rule', 'decision', 'lesson', 'project'];

/** Sub-categories a `project`-level memory may carry. */
export const PROJECT_SUBCATEGORIES = ['overview', 'structure', 'decisions', 'quotes', 'ops', 'todo'];
export const PROJECT_SUBCATEGORY_SET = new Set(PROJECT_SUBCATEGORIES);
