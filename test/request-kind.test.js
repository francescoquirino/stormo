'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {requestKind}=require('../src/main/request-kind');
test('greetings and general questions get a direct answer',()=>{
  for(const prompt of ['ciao!','Come stai?','Grazie','Hello','Che modello usa la regia?','Come funziona il model router?','Spiegami cosa significa effort','Quali sono le fasce A B C?','Dimmi il risultato del lavoro','Traduci questo testo in inglese','Cos’è una funzione Python?','Non scrivere codice, spiegami il concetto','Come si crea un file in Windows?','How do I create a file in Windows?','Spiegami come si revisiona il codice'])
    assert.equal(requestKind(prompt),'conversation',prompt);
});
test('development requests, reviews and mixed greetings require the router',()=>{
  for(const prompt of ['Crea una app','Scrivi una funzione Python','Ciao, correggi il bug nella funzione','Revisiona il codice','Progetta il backend','Aggiungi il pulsante all’interfaccia','Fix the bug in this code','Write a test for this function','Usa il router per rispondere','Spiegami il piano e poi implementa il codice'])
    assert.equal(requestKind(prompt),'coding',prompt);
});
test('continuations keep the coding work\'s context, greetings stay direct',()=>{
  assert.equal(requestKind('continua',['Crea una app']),'coding');
  assert.equal(requestKind('sì',['Scrivi una funzione Python','ciao']),'coding');
  assert.equal(requestKind('ciao',['Scrivi una funzione Python']),'conversation');
  assert.equal(requestKind('ok',['Come stai?']),'conversation');
});
