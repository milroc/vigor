// Overview-specific palette + activity classification, shared by the page and
// the day modal (kept out of Overview.jsx to avoid circular imports).

// Exercise-ring minutes split by kind [cardio, lift, recovery, unattributed]:
// ONE teal hue (unused by the zone / NEAT / sleep palettes) ramped by
// lightness — lift darkest, cardio mid, recovery light, unattributed lightest.
export const EX_COLORS = ['#2fb3a0', '#0c6e60', '#8bd9cb', '#d3efe9'];
export const EX_LABELS = ['Cardio', 'Lift', 'Recovery', 'Unattributed'];

// Apple activity → category index into EX_COLORS/EX_LABELS (same lists as the
// server's exercise-split classification in scripts/goalMetrics.cjs).
const LIFT = new Set(['TraditionalStrengthTraining', 'FunctionalStrengthTraining', 'CoreTraining', 'Other']);
const RECOVERY = new Set(['Yoga', 'Flexibility', 'Cooldown', 'MindAndBody', 'Pilates', 'PreparationAndRecovery']);
export const activityCategory = a => (LIFT.has(a) ? 1 : RECOVERY.has(a) ? 2 : 0);

// "FunctionalStrengthTraining" → "Functional Strength Training"
export const prettyActivity = a => String(a || '').replace(/([a-z])([A-Z])/g, '$1 $2');
