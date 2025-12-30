
export function cleanDisplayName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) {
    return '';
  }
  // Remove (H) or (F) case insensitive, potentially with spaces around
  let cleaned = rawName.replace(/\s*\([HFhf]\)\s*/g, ' ');

  // Remove "Née ..." and everything after, case insensitive
  // Using regex with case insensitive flag
  const neeIndex = cleaned.toLowerCase().indexOf(' née ');
  if (neeIndex !== -1) {
    cleaned = cleaned.substring(0, neeIndex);
  } else {
     // Check if it starts with "Née " (unlikely for full name but possible part)
     // or check if it is just "Née" somewhere.
     // The user said "la partie apres 'née ...' ne sert a rien".
     // I will assume " Née " with spaces is the trigger to avoid cutting names like "Renée".
     // But wait, "Renée" doesn't have spaces around "née".
     // So " Née " (space before and after) or " Née" at end?
     // Actually, looking at `normalizeName` regex: `\s*Née\s+`
     // So I should look for `\s+Née\s+` (case insensitive).

     // Let's use regex for split/replace.
     cleaned = cleaned.replace(/\s+Née\s+.*$/i, '');
  }

  return cleaned.trim();
}

export function naturalSort(a, b) {
  // Parsing numbers from strings for comparison
  const ax = [], bx = [];

  a.replace(/(\d+)|(\D+)/g, function(_, $1, $2) { ax.push([$1 || Infinity, $2 || ""]) });
  b.replace(/(\d+)|(\D+)/g, function(_, $1, $2) { bx.push([$1 || Infinity, $2 || ""]) });

  while(ax.length && bx.length) {
      const an = ax.shift();
      const bn = bx.shift();
      const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
      if(nn) return nn;
  }

  return ax.length - bx.length;
}
