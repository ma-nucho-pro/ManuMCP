import { SignedTokenCodec } from "../core/cursor.js";
import { TunnelGPTError } from "../core/errors.js";
import { PathAuthorizer } from "../core/path-authorizer.js";
import { withTimeout } from "../core/operation.js";
import { AtomicWriter } from "../services/atomic-writer.js";
import { SafeReader } from "../services/safe-reader.js";
import { SearchService } from "../services/search-service.js";
import { Walker } from "../services/walker.js";
import { RequestAdmission } from "../transports/request-admission.js";
import type { ManuMcpConfig } from "./config.js";

export interface ManuMcpServices {
    readonly config: ManuMcpConfig;
    readonly authorizer: PathAuthorizer;
    readonly reader: SafeReader;
    readonly walker: Walker;
    readonly search: SearchService;
    readonly writer: AtomicWriter;
    readonly confirmations: SignedTokenCodec;
    readonly admission: RequestAdmission;
    readonly usedConfirmationTokens: Map<string, number>;
    readonly inFlightConfirmationTokens: Set<string>;
}

export async function createServices(config: ManuMcpConfig): Promise<ManuMcpServices> {
    const authorizer = await PathAuthorizer.create(config.access);
    const reader = new SafeReader();
    const confirmations = new SignedTokenCodec(config.access.limits.confirmationTtlMs, config.confirmationKey);
    return {
        config,
        authorizer,
        reader,
        walker: new Walker(authorizer),
        search: new SearchService(new Walker(authorizer), authorizer, reader),
        writer: new AtomicWriter(config.access, authorizer, reader, confirmations),
        confirmations,
        admission: new RequestAdmission({ maxActive: 4, maxQueued: 8, queueTimeoutMs: 2_000 }),
        usedConfirmationTokens: new Map<string, number>(),
        inFlightConfirmationTokens: new Set<string>(),
    };
}

export async function runBounded<T>(services: ManuMcpServices, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const admission = await services.admission.acquire(signal);
    if (admission.kind !== "admitted") {
        throw new TunnelGPTError("LIMIT_EXCEEDED", "ManuMCP está ocupado; reintenta más tarde.", {
            reason: admission.reason,
            retryAfterMs: admission.retryAfterMs,
        });
    }
    try {
        return await withTimeout(operation, services.config.operationTimeoutMs, signal);
    }
    finally {
        admission.release();
    }
}

export async function runConfirmed<T>(services: ManuMcpServices, token: string | undefined, operation: () => Promise<T>): Promise<T> {
    if (token === undefined)
        return operation();
    const now = Date.now();
    for (const [usedToken, expiresAt] of services.usedConfirmationTokens) {
        if (expiresAt < now)
            services.usedConfirmationTokens.delete(usedToken);
    }
    if (services.usedConfirmationTokens.has(token) || services.inFlightConfirmationTokens.has(token))
        throw new TunnelGPTError("CONFIRMATION_INVALID", "La confirmación ya fue usada o está en curso.");
    services.inFlightConfirmationTokens.add(token);
    try {
        const result = await operation();
        services.usedConfirmationTokens.set(token, now + services.config.access.limits.confirmationTtlMs);
        return result;
    }
    finally {
        services.inFlightConfirmationTokens.delete(token);
    }
}
