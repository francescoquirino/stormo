'use strict';
// Reinforces explicit requests; the director interprets the others semantically using the already-loaded skill.
function requestKind(prompt, recent = []) {
  const text = String(prompt || '').normalize('NFKD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").toLowerCase().trim();
  const action = /\b(?:crea\w*|scriv\w*|implement\w*|aggiung\w*|modific\w*|corregg\w*|sistem\w*|risolv\w*|svilupp\w*|progett\w*|revision\w*|ottimizz\w*|refactor\w*|debug\w*|fix\w*|build|create|write|add|change|update|review|design|develop|test|deploy)\b/;
  const subject = /\b(?:codic\w*|code|app|applicazion\w*|software|funzion\w*|function|classe|class|script|bug\w*|error\w*|errore|file|pagina|sito|website|programma|progetto|project|api|backend|frontend|database|test|component\w*|repository|repo|css|html|python|javascript|typescript|interfaccia|ui|router|regole|exe)\b/;
  // A prohibition on writing/changing is not a development request.
  const affirmative = text.replace(/\b(?:non|don't|do not)\s+(?:scriv\w*|modific\w*|crea\w*|corregg\w*|write|change|create|edit)\b/g, '');
  if (/\b(?:usa|utilizza|use|run|lancia)\s+(?:il\s+)?(?:model\s+)?router\b/.test(affirmative)) return 'coding';
  const concreteIssue = /\b(?:debug|stack\s?trace|traceback|non funziona|doesn't work|crasha|crash)\b/.test(text) && subject.test(text);
  const information = /^(?:spiega\w*|cos'e|che (?:cosa|significa)|cosa significa|come (?:si|funziona)|explain|what (?:is|does)|how (?:do|does|to|can))\b/.test(text);
  const mixedAction = /\b(?:poi|quindi|then|e|and)\s+(?:crea|scrivi|implementa|aggiungi|modifica|correggi|sistema|risolvi|sviluppa|revisiona|fix|write|create|add|implement|change|review|build)\b/.test(text);
  if (information && !concreteIssue && !mixedAction) return 'conversation';
  if ((action.test(affirmative) && subject.test(text)) || concreteIssue) return 'coding';
  if (/^(?:ok|okay|si|yes|va bene|fallo|do it|continua|continue|procedi|proceed|riprendi|resume|sistema|correggi)[\s.!?,]*$/.test(text)) {
    for (const previous of (Array.isArray(recent) ? recent : []).slice(-6).reverse()) {
      const kind = requestKind(previous);
      if (kind === 'coding') return 'coding';
      if (kind === 'automatic') break;
    }
    return 'conversation';
  }
  if (/^(?:ciao|salve|buongiorno|buonasera|buonanotte|grazie|thanks|thank you|hello|hi|hey|come stai|how are you)[\s.!?,]*$/.test(text)
      || /^(?:chi|che|cosa|cos'e|come|quanto|quale|quali|dimmi|spiega\w*|traduci|riassumi|what|who|how|which|explain|translate)\b/.test(text)
      || /\b(?:spiegami|spiega|explain|traduci|translate)\b/.test(affirmative)) return 'conversation';
  return 'automatic';
}
module.exports = { requestKind };
