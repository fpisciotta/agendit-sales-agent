// src/memory/memory.module.ts

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Derivacion } from './entities/derivacion.entity';
import { LeadPublicidad } from './entities/lead-publicidad.entity';
import { Mensaje } from './entities/mensaje.entity';
import { MemoryService } from './memory.service';

@Module({
  imports: [TypeOrmModule.forFeature([Mensaje, Derivacion, LeadPublicidad])],
  providers: [MemoryService],
  exports: [MemoryService],
})
export class MemoryModule {}
