/**
 * @module names/dns-label
 * @description The one RFC 1123 DNS label pattern (1-63 chars, lowercase
 *   alphanumeric ends, `-` inside) shared by the imagebuild, verb hook, and
 *   enroll validators so their label checks cannot disagree.
 */

/** A Kubernetes DNS-1123 label: 1-63 chars, `[a-z0-9]` ends, `[-a-z0-9]` inside. */
export const DNS_LABEL_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;
