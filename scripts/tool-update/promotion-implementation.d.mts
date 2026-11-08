export const promotionImplementationScheme: 'promotion-implementation-v1';
export const promotionImplementationFiles: readonly string[];
export const promotionImplementationExcludedPaths: readonly string[];
export function promotionImplementationDigest(root: string): Promise<string>;
