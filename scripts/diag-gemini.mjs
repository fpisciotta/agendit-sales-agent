// scripts/diag-gemini.mjs — Aísla qué argumento rechaza Gemini
//
// Uso: node scripts/diag-gemini.mjs
//
// Prueba la llamada por capas: cada caso agrega un argumento al anterior.
// El primero que falle es el culpable.

import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '@google/genai';

// Cargar .env.local a mano (sin dependencias)
for (const linea of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = linea.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const modelo = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const systemPrompt = 'Eres una asesora de ventas. Responde en español, breve.';
const contents = [
  { role: 'user', parts: [{ text: 'Hola' }] },
];

const casos = [
  ['1. mínimo (model + contents)', { model: modelo, contents }],
  ['2. + systemInstruction', { model: modelo, contents, config: { systemInstruction: systemPrompt } }],
  [
    '3. + maxOutputTokens',
    { model: modelo, contents, config: { systemInstruction: systemPrompt, maxOutputTokens: 1024 } },
  ],
  [
    '4. + thinkingConfig 0',
    {
      model: modelo,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
      },
    },
  ],
  [
    '5. historial con rol model',
    {
      model: modelo,
      contents: [
        { role: 'user', parts: [{ text: 'Hola' }] },
        { role: 'model', parts: [{ text: '¡Hola! ¿En qué te ayudo?' }] },
        { role: 'user', parts: [{ text: 'Cuánto sale el plan Pro?' }] },
      ],
      config: { systemInstruction: systemPrompt, maxOutputTokens: 1024 },
    },
  ],
];

console.log(`Modelo: ${modelo}\n`);

for (const [nombre, params] of casos) {
  try {
    const r = await ai.models.generateContent(params);
    const texto = (r.text ?? '').replace(/\n/g, ' ').slice(0, 60);
    console.log(`OK    ${nombre} → "${texto}"`);
  } catch (e) {
    console.log(`FALLA ${nombre}`);
    console.log(`      ${e.message?.slice(0, 300)}`);
    break; // no seguir: los casos siguientes incluyen este argumento
  }
}

console.log('\n--- modelos disponibles para esta API key ---');
try {
  for await (const m of await ai.models.list()) {
    if (m.name?.includes('flash') || m.name?.includes('pro')) {
      console.log(`  ${m.name}`);
    }
  }
} catch (e) {
  console.log(`  no se pudo listar: ${e.message?.slice(0, 200)}`);
}
