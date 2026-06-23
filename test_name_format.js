const nameRegex =
  /^"?\s*(?<title>M\.|Mme\.)\s+(?<lastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<firstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*?)\s*(?:\s*Née\s+(?<maidenLastName>[A-Z'-]+(?:\s[A-Z'-]+)*)\s+(?<maidenFirstName>[A-Za-zÀ-ÿ'-]+(?:(?:,\s*|\s|-)[A-Za-zÀ-ÿ'-]+)*))?\s*\((?<gender>F|H)\)(?:\s*(?<nir>\d{15})\s*\[NIR\])?\s*"?$/

function formatDisplayName(rawName) {
  if (typeof rawName !== 'string' || !rawName.trim()) return ''
  const singleLineName = rawName.replace(/\s+/g, ' ').trim()
  const match = singleLineName.match(nameRegex)

  if (match) {
    const { title, lastName, firstName } = match.groups
    const firstFirstName = firstName.split(/[ ,]/)[0]
    return `${title} ${lastName} ${firstFirstName}`
  }
  return singleLineName
}

const tests = [
  { input: 'M. DUPONT Jean (H)', expected: 'M. DUPONT Jean' },
  { input: 'Mme. MARTIN Marie-Claude (F)', expected: 'Mme. MARTIN Marie-Claude' },
  { input: 'M. TEST Jean Pierre (H)', expected: 'M. TEST Jean' },
  { input: 'Mme. DURAND Née DUPONT Marie (F)', expected: 'Mme. DURAND Marie' },
]

let failed = false
tests.forEach((t) => {
  const result = formatDisplayName(t.input)
  if (result !== t.expected) {
    console.error(`FAILED: "${t.input}" -> "${result}". Expected "${t.expected}"`)
    failed = true
  } else {
    console.log(`PASSED: "${t.input}" -> "${result}"`)
  }
})

if (failed) process.exit(1)
