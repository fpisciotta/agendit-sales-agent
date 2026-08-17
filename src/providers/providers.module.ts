// src/providers/providers.module.ts — Factory del proveedor según .env

import { Module } from '@nestjs/common';

import { MetaProvider } from './meta.provider';
import { PROVEEDOR_WHATSAPP } from './whatsapp-provider.interface';

@Module({
  providers: [
    MetaProvider,
    {
      provide: PROVEEDOR_WHATSAPP,
      // Hoy solo Meta Cloud API. Para agregar otro proveedor, implementá
      // ProveedorWhatsApp y elegí acá según WHATSAPP_PROVIDER.
      useExisting: MetaProvider,
    },
  ],
  exports: [PROVEEDOR_WHATSAPP],
})
export class ProvidersModule {}
