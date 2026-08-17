// src/config/prompts-config.service.ts — Lee config/prompts.yaml y config/business.yaml

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

interface ArchivoPrompts {
  system_prompt?: string;
  fallback_message?: string;
  error_message?: string;
}

interface ArchivoBusiness {
  negocio?: { nombre?: string; descripcion?: string; horario?: string };
  agente?: { nombre?: string; tono?: string; casos_de_uso?: string[] };
}

const SYSTEM_PROMPT_POR_DEFECTO = 'Eres un asistente útil. Responde en español.';
const FALLBACK_POR_DEFECTO = 'Disculpa, no entendí tu mensaje. ¿Podrías reformularlo?';
const ERROR_POR_DEFECTO =
  'Lo siento, estoy teniendo problemas técnicos. Por favor intenta de nuevo en unos minutos.';

@Injectable()
export class PromptsConfigService implements OnModuleInit {
  private readonly logger = new Logger(PromptsConfigService.name);
  private readonly directorio = process.env.CONFIG_DIR ?? join(process.cwd(), 'config');

  private prompts: ArchivoPrompts = {};
  private business: ArchivoBusiness = {};

  onModuleInit(): void {
    this.prompts = this.leerYaml<ArchivoPrompts>('prompts.yaml');
    this.business = this.leerYaml<ArchivoBusiness>('business.yaml');
    if (!this.prompts.system_prompt) {
      this.logger.warn('config/prompts.yaml sin system_prompt — usando el genérico');
    }
  }

  get systemPrompt(): string {
    return this.prompts.system_prompt ?? SYSTEM_PROMPT_POR_DEFECTO;
  }

  get mensajeFallback(): string {
    return this.prompts.fallback_message ?? FALLBACK_POR_DEFECTO;
  }

  get mensajeError(): string {
    return this.prompts.error_message ?? ERROR_POR_DEFECTO;
  }

  get infoNegocio(): ArchivoBusiness {
    return this.business;
  }

  private leerYaml<T>(nombre: string): T {
    const ruta = join(this.directorio, nombre);
    try {
      return (parse(readFileSync(ruta, 'utf8')) as T) ?? ({} as T);
    } catch (error) {
      this.logger.error(`No se pudo leer ${ruta}: ${(error as Error).message}`);
      return {} as T;
    }
  }
}
