// The launcher and shell completion share this list.
export const cliCommands = {
  start: ['--port', '--no-browser', '--help'],
  open: ['--port', '--no-browser', '--help'],
  stop: ['--force', '--help'],
  restart: ['--port', '--no-browser', '--force', '--help'],
  status: ['--help'],
  port: ['--help'],
  logs: ['--help'],
  doctor: ['--help'],
  completion: ['--help'],
  help: [],
}
export const completionActions = ['bash', 'install']
