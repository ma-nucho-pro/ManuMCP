import { SignedTokenCodec } from "../core/cursor.js";
import { PathAuthorizer } from "../core/path-authorizer.js";
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
export declare function createServices(config: ManuMcpConfig): Promise<ManuMcpServices>;
export declare function runBounded<T>(services: ManuMcpServices, signal: AbortSignal, operation: () => Promise<T>): Promise<T>;
export declare function runConfirmed<T>(services: ManuMcpServices, token: string | undefined, operation: () => Promise<T>): Promise<T>;
