import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as fs from 'fs/promises'
import * as io from '@actions/io'
import * as mutantschema from './mutantschema'
import YAML from 'yaml'

type BreakPoint = {
  minimumMutantsDetected: number
  pointsToAward: number
}
type GradingConfig = {
  gradedUnits: GradedUnit[]
  submissionFiles: {name: string; dest: string}[]
  expectedTSIgnore: number
  expectedESlintIgnore: number
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
async function runStryker(): Promise<mutantschema.MutationTestResult> {
  await exec.exec('npx', ['stryker', 'run'], {cwd: 'implementation-to-test'})
  const report = JSON.parse(
    await fs.readFile(
      'implementation-to-test/reports/mutation/mutation.json',
      'utf-8'
    )
  ) as mutantschema.MutationTestResult
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
  mutationResults: mutantschema.MutationTestResult
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
  const mutantContainsThisGradedUnit = (
    mutant: mutantschema.MutantResult
  ): boolean => {
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
  const breakPointsReversed = config.breakPoints.concat([]).reverse()
  const breakPointHit = breakPointsReversed.find(
    bp => bp.minimumMutantsDetected <= mutantsDetected
  )

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
  results: mutantschema.MutationTestResult
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

async function executeCommandAndGetOutput(
  command: string,
  ignoreFailures = false
): Promise<string> {
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
      },
      ignoreReturnCode: ignoreFailures
    })
    myOutput += myError
    core.info(`Command Output:<${myOutput}>`)
    return myOutput
  } catch (err) {
    throw new Error(`Command failed with output:\n${myOutput + myError}`)
  }
}
async function outputGrading(res: GraderOutput): Promise<void> {
  core.info(JSON.stringify(res))
  core.setOutput('test-results', JSON.stringify(res))
  if (process.argv.length > 3) {
    const outputFile = process.argv[3]
    await fs.writeFile(outputFile, JSON.stringify(res))
  }
}

async function run(): Promise<void> {
  try {
    let submissionDirectory = core.getInput('submission-directory', {})
    if (!submissionDirectory) {
      if (process.argv.length < 3)
        throw new Error(
          'Could not find a submission-directory to grade, specify as arg or in GHA'
        )
      submissionDirectory = process.argv[2]
    }
    let generalOutput =
      'CS4530 Spring 2022 HW3 grading script beginning...\n Examining submission...\n'
    const schema = YAML.parse(
      await fs.readFile('grading.yml', 'utf-8')
    ) as GradingConfig
    validateConfig(schema)
    const fileResults = await Promise.all(
      schema.submissionFiles.map(async submissionFile => {
        const submissionPath = `${submissionDirectory}/${submissionFile.name}`
        try {
          await io.cp(
            submissionPath,
            `implementation-to-test/${submissionFile.dest}`
          )
          generalOutput += `\tMoved submitted file ${submissionFile.name} to ${submissionFile.dest}\n`
          return true
        } catch (err) {
          core.error(err as Error)
          generalOutput += `\tWARNING: Could not find submission file ${submissionFile.name}\n`
          return false
        }
      })
    )

    try {
      const anyFilesFound = fileResults.find(v => v === true)
      if (!anyFilesFound) {
        throw new Error(
          `This submission does not contain any of the expected files.
          Please be sure to upload only the following files (not in a zip, not in a directory, just these files): ${schema.submissionFiles
            .map(f => f.name)
            .join()}`
        )
      }
      //Check for eslint-disable, tsignore and fail
      const esLintDisables = (
        await executeCommandAndGetOutput('grep -ro eslint-disable src', true)
      )
        .trim()
        .split('\n').length
      if (esLintDisables > schema.expectedESlintIgnore) {
        throw new Error(
          `Only expected to find ${schema.expectedESlintIgnore} eslint-disable annotations from the handout code, but found total of ${esLintDisables}. You may not add additional eslint-disable flags.`
        )
      }
      const tsIgnores = (
        await executeCommandAndGetOutput('grep -ro ts-ignore src', true)
      )
        .trim()
        .split('\n')
      if (
        tsIgnores.length > schema.expectedTSIgnore &&
        !(tsIgnores.length === 1 && tsIgnores[0] === '')
      ) {
        throw new Error(
          `Only expected to find ${schema.expectedTSIgnore} ts-ignore annotations from the handout code, but found total of ${tsIgnores}. You may not add additional eslint-disable flags.`
        )
      }

      //install or fail
      generalOutput += `\nCompiling submission...\n`
      await executeCommandAndGetOutput('npm install')
      generalOutput += 'OK.\n'

      //lint or fail
      generalOutput += `\nRunning ESLint...\n`
      await executeCommandAndGetOutput(
        'npx eslint . --ext .js,.jsx,.ts,.tsx -f visualstudio'
      )
      generalOutput += 'OK.\n'

      //Do dry run without stryker first, or fail
      generalOutput += `\nRunning tests without any faults, all tests must pass this step in order to receive any marks`
      await executeCommandAndGetOutput('npm test')
      generalOutput += 'OK.\n'

      generalOutput += `\nRunning tests with injected faults...\n`
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
      await outputGrading(res)
    } catch (err) {
      // core.error(err as Error)
      generalOutput += (err as Error).toString()
      generalOutput += `\n\n^^^^ERROR OCURRED. This submission will not be graded until this/these errors are resolved. Your submission must pass 'npm install', 'npm run lint' and 'npm test' in order to be graded.\n`
      const res: GraderOutput = {
        stdout_visibility: 'visible',
        score: 0,
        output: generalOutput
      }
      await outputGrading(res)
    }
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}
run()
