// src/tests/chat-local.ts — Probar el agente sin WhatsApp, desde la terminal
//
// Uso: npm run test:local

import 'reflect-metadata';
import { createInterface } from 'node:readline/promises';
import { NestFactory } from '@nestjs/core';

import { AppModule } from '../app.module';
import { BrainService } from '../brain/brain.service';
import { MemoryService } from '../memory/memory.service';

const TELEFONO_TEST = 'test-local-001';

async function main(): Promise<void> {
  // Contexto sin servidor HTTP: solo necesitamos los servicios.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['warn', 'error'],
  });

  const brain = app.get(BrainService);
  const memory = app.get(MemoryService);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log('='.repeat(55));
  console.log('   Agendit Sales Agent — Test Local');
  console.log('='.repeat(55));
  console.log('');
  console.log('  Escribí mensajes como si fueras un cliente.');
  console.log('  Comandos especiales:');
  console.log("    'limpiar'  — borra el historial");
  console.log("    'salir'    — termina el test");
  console.log('');
  console.log('-'.repeat(55));
  console.log('');

  for (;;) {
    const mensaje = (await rl.question('Tu: ')).trim();

    if (mensaje.length === 0) continue;

    if (mensaje.toLowerCase() === 'salir') {
      console.log('\nTest finalizado.');
      break;
    }

    if (mensaje.toLowerCase() === 'limpiar') {
      await memory.limpiarHistorial(TELEFONO_TEST);
      console.log('[Historial borrado]\n');
      continue;
    }

    // El historial se pide ANTES de guardar el mensaje actual.
    const historial = await memory.obtenerHistorial(TELEFONO_TEST);

    process.stdout.write('\nAgente: ');
    const respuesta = await brain.generarRespuesta(mensaje, historial);
    console.log(respuesta);
    console.log('');

    await memory.guardarMensaje(TELEFONO_TEST, 'user', mensaje);
    await memory.guardarMensaje(TELEFONO_TEST, 'assistant', respuesta);
  }

  rl.close();
  await app.close();
}

void main();
