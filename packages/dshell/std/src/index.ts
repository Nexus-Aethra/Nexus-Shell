/**
 * dshell's standard layer.
 *
 * Everything here is shared machinery that must not belong to any one feature:
 * first the wire contracts ({@link ./contracts.ts}), and as the refactor
 * continues, the dsh seam adapters (route definition, session/world addressing,
 * capability probing) that today live duplicated inside feature packages.
 *
 * The rule that makes this layer worth having: it is the ONLY dshell package
 * allowed to care about how dsh spells things. A feature package imports from
 * here and keeps to its own product logic, so a dsh interface change is
 * absorbed in one place instead of re-implemented per plugin.
 */

export * from './contracts.js'
