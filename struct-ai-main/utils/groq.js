const { callLLM } = require('./llm');
const { getThemeSkinparam } = require('./themes');

/**
 * Strips markdown fences, normalizes @startuml/@enduml blocks, removes any
 * stray !theme directives, collapses double braces, and injects our own
 * skinparam theme block. Mirrors the original Python clean_syntax() logic.
 */
function cleanSyntax(raw, themeSkinparam) {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*/gm, '');
  text = text.replace(/```\s*$/gm, '');
  text = text.trim();

  const tagPairs = [
    ['@startuml', '@enduml'],
    ['@startmindmap', '@endmindmap'],
  ];

  for (const [openTag, closeTag] of tagPairs) {
    const pattern = new RegExp(
      `(${escapeRegex(openTag)}[\\s\\S]*?${escapeRegex(closeTag)})`,
      'i'
    );
    const match = text.match(pattern);
    if (match) {
      let block = match[1].trim();
      block = block.replace(/!theme\s+\S+\n?/g, '');
      block = block.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
      if (themeSkinparam && openTag === '@startuml') {
        block = block.replace('@startuml', `@startuml\n${themeSkinparam}`);
      }
      return block;
    }
  }

  let inner = text.replace(/@start\w+\s*/gi, '');
  inner = inner.replace(/@end\w+\s*/gi, '');
  inner = inner.replace(/!theme\s+\S+\n?/g, '');
  inner = inner.replace(/\{\{/g, '{').replace(/\}\}/g, '}').trim();

  if (!inner) {
    throw new Error('AI returned empty diagram content — please try again.');
  }

  const header = themeSkinparam ? `@startuml\n${themeSkinparam}\n` : '@startuml\n';
  return `${header}${inner}\n@enduml`;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function generateAiSyntax(projectName, diagramType, themeName) {
  const raw = await callLLM(projectName, diagramType);
  const themeSkinparam = themeName ? getThemeSkinparam(themeName) : '';
  let block = cleanSyntax(raw, themeSkinparam);
  block = block.replace(/\{\{/g, '{').replace(/\}\}/g, '}');
  return block;
}

module.exports = { callLLM, cleanSyntax, generateAiSyntax };
