import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import * as fs from 'fs/promises'
import {stderr} from 'process'
import YAML from 'yaml'
import {MutantResult, MutationTestResult} from './mutantschema'

type BreakPoint = {
  minimumMutantsDetected: number
  pointsToAward: number
}
type GradingConfig = {
  gradedUnits: GradedUnit[]
  submissionFiles: {name: string; dest: string}[]
}
type GradedUnit = {
  name: string
  breakPoints: BreakPoint[]
  locations: string[] //use same format as stryker.conf.json
}
type TestResult = {
  score: number
  max_score: number
  name: string
  output: string
}
type GraderOutput = {
  output?: string
  stdout_visibility: 'hidden' | 'after_due_date' | 'after_published' | 'visible'
  tests?: TestResult[]
  score?: number
}
async function runStryker(): Promise<MutationTestResult> {
  await exec.exec('npx', ['stryker', 'run'], {cwd: 'implementation-to-test'})
  const report = JSON.parse(
    await fs.readFile(
      'implementation-to-test/reports/mutation/mutation.json',
      'utf-8'
    )
  ) as MutationTestResult
  return report
}
function extractLocationInformation(location: string): {
  fileName: string
  startLine: number
  endLine: number
} {
  const parts = location.split(':')
  if (parts.length > 2) {
    throw new Error('No support for column mutators right now.')
  }
  const fileName = parts[0]
  let startLine
  let endLine
  if (parts[1].includes('-')) {
    const lineParts = parts[1].split('-')
    startLine = parseInt(lineParts[0])
    endLine = parseInt(lineParts[1])
  } else {
    startLine = parseInt(parts[1])
    endLine = startLine
  }
  return {fileName, startLine, endLine}
}
function gradeMutationUnit(
  config: GradedUnit,
  mutationResults: MutationTestResult
): TestResult {
  const ret: TestResult = {
    score: 0,
    max_score: Math.max(...config.breakPoints.map(bp => bp.pointsToAward)),
    name: config.name,
    output: ''
  }
  const gradedLocations = config.locations.map(extractLocationInformation)
  const mutatedFileContainsAGradedUnit = (fileName: string): boolean => {
    return (
      gradedLocations.find(mutatedLocation =>
        fileName.includes(mutatedLocation.fileName)
      ) !== undefined
    )
  }
  const mutantContainsThisGradedUnit = (mutant: MutantResult): boolean => {
    return (
      gradedLocations.find(mutatedLocation => {
        return (
          mutatedLocation.startLine <= mutant.location.start.line &&
          mutatedLocation.endLine >= mutant.location.start.line
        )
      }) !== undefined
    )
  }
  const mutantsDetected = Object.keys(mutationResults.files)
    .filter(file => mutatedFileContainsAGradedUnit(file))
    .reduce((mutantsFoundSoFar, file) => {
      const mutants = mutationResults.files[file]
      return (
        mutantsFoundSoFar +
        mutants.mutants
          .filter(mutantContainsThisGradedUnit)
          .reduce((mutantsFoundThisFile, mutant) => {
            // console.log(mutant)
            if (mutant.status === 'Killed') return mutantsFoundThisFile + 1
            return mutantsFoundThisFile
          }, 0)
      )
    }, 0)
  // Determine which break point we hit
  const breakPointHit = config.breakPoints
    .reverse()
    .find(bp => bp.minimumMutantsDetected <= mutantsDetected)

  if (breakPointHit) ret.score = breakPointHit.pointsToAward
  else ret.score = 0
  const maxMutantsToFind =
    config.breakPoints[config.breakPoints.length - 1].minimumMutantsDetected
  ret.output = `Faults detected: ${mutantsDetected}/${maxMutantsToFind}`
  return ret
}
function validateConfig(config: GradingConfig): void {
  for (const gradedUnit of config.gradedUnits) {
    let lastBP = -1
    for (const breakPoint of gradedUnit.breakPoints) {
      if (breakPoint.minimumMutantsDetected <= lastBP)
        throw new Error(
          `Error in config for gradedUnit ${gradedUnit.name}, break points should be sorted in ascending order by minimumMutantsDetected, without duplicates`
        )
      lastBP = breakPoint.minimumMutantsDetected
    }
  }
}
async function gradeStrykerResults(
  schema: GradingConfig,
  results: MutationTestResult
): Promise<GraderOutput> {
  const testResults: TestResult[] = schema.gradedUnits.map(gradedUnit =>
    gradeMutationUnit(gradedUnit, results)
  )
  const output: GraderOutput = {
    output: '',
    stdout_visibility: 'hidden',
    tests: testResults
  }
  return output
}

async function executeCommandOrFailWithOutput(command: string): Promise<void> {
  let myOutput = ''
  let myError = ''
  try {
    core.info(`Running ${command}`)
    await exec.exec(command, [], {
      cwd: 'implementation-to-test',
      listeners: {
        stdout: (data: Buffer) => {
          myOutput += data.toString()
        },
        stderr: (data: Buffer) => {
          myError += data.toString()
        }
      }
    })
    myOutput += myError
    core.info(`Command Output:<${myOutput}>`)
  } catch (err) {
    throw new Error(`Command failed with output:\n${myOutput + myError}`)
  }
}

async function run(): Promise<void> {
  try {
    let submissionDirectory = core.getInput('submission-directory', {})
    if (!submissionDirectory) {
      submissionDirectory = 'solutions/non-green-tests'
    }
    let generalOutput = 'Grading submission...\n'
    const schema = YAML.parse(
      await fs.readFile('grading.yml', 'utf-8')
    ) as GradingConfig
    validateConfig(schema)
    await Promise.all(
      schema.submissionFiles.map(async submissionFile => {
        const submissionPath = `${submissionDirectory}/${submissionFile.name}`
        try {
          await io.cp(
            submissionPath,
            `implementation-to-test/${submissionFile.dest}`
          )
          generalOutput += `Moved submitted file ${submissionFile.name} to ${submissionFile.dest}\n`
        } catch (err) {
          core.error(err as Error)
          generalOutput += `WARNING: Could not find submission file ${submissionFile.name}\n`
        }
      })
    )

    try {
      //install or fail
      generalOutput += `Compiling submission...\n`
      await executeCommandOrFailWithOutput('npm install')
      generalOutput += 'OK.\n'

      //lint or fail
      generalOutput += `Running ESLint...\n`
      await executeCommandOrFailWithOutput(
        'npx eslint . --ext .js,.jsx,.ts,.tsx -f visualstudio'
      )
      generalOutput += 'OK.\n'

      //Do dry run without stryker first, or fail
      generalOutput += `Running tests without any faults, all tests must pass this step in order to receive any marks`
      await executeCommandOrFailWithOutput('npm test')
      generalOutput += 'OK.\n'

      generalOutput += `Checking that tests run successfully without faults injected\n`
      core.info('Running tests without stryker')
      generalOutput += `Running tests with injected faults...\n`
      let res: GraderOutput
      try {
        const report = await runStryker()
        res = await gradeStrykerResults(schema, report)
        generalOutput += `Tests successfully ran`
        res.output = generalOutput
      } catch (err) {
        core.error(err as Error)
        generalOutput += `An internal error occurred, and no test results were generated.\n`
        res = {
          stdout_visibility: 'visible',
          score: 0,
          output: generalOutput
        }
      }
      core.setOutput('test-results', JSON.stringify(res))
    } catch (err) {
      // core.error(err as Error)
      generalOutput += (err as Error).toString()
      generalOutput += `\n\n^^^^ERROR OCURRED. This submission will not be graded until this/these errors are resolved. Your submission must pass 'npm install', 'npm run lint' and 'npm test' in order to be graded.\n`
      const res: GraderOutput = {
        stdout_visibility: 'visible',
        score: 0,
        output: generalOutput
      }
      core.setOutput('test-results', JSON.stringify(res))
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
run()
