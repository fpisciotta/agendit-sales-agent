// src/ai/ai.module.ts — Factory del proveedor de IA según AI_PROVIDER

import { Logger, Module, Provider } from '@nestjs/common';

import { PROVEEDOR_IA, ProveedorIA } from './ai-provider.interface';
import { ClaudeProvider } from './claude.provider';
import { GeminiProvider } from './gemini.provider';

const PROVEEDORES_SOPORTADOS = ['gemini', 'claude'] as const;
type NombreProveedor = (typeof PROVEEDORES_SOPORTADOS)[number];

/**
 * Elige el proveedor según AI_PROVIDER. Falla al arrancar si el valor no se
 * reconoce: mejor no levantar que atender clientes con el modelo equivocado.
 */
const proveedorIaFactory: Provider = {
  provide: PROVEEDOR_IA,
  inject: [GeminiProvider, ClaudeProvider],
  useFactory: (gemini: GeminiProvider, claude: ClaudeProvider): ProveedorIA => {
    const elegido = (process.env.AI_PROVIDER ?? 'gemini').toLowerCase();

    if (!PROVEEDORES_SOPORTADOS.includes(elegido as NombreProveedor)) {
      throw new Error(
        `AI_PROVIDER="${elegido}" no soportado. Usá: ${PROVEEDORES_SOPORTADOS.join(' | ')}`,
      );
    }

    const proveedor: ProveedorIA = elegido === 'claude' ? claude : gemini;
    new Logger('AiModule').log(`Proveedor de IA: ${proveedor.nombre} (${proveedor.modelo})`);
    return proveedor;
  },
};

@Module({
  providers: [GeminiProvider, ClaudeProvider, proveedorIaFactory],
  exports: [PROVEEDOR_IA],
})
export class AiModule {}
