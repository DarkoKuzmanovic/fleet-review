export const workspace = {
  getConfiguration: () => ({
    get: (key: string, defaultVal: any) => defaultVal,
  }),
  workspaceFolders: [{ uri: { fsPath: '/mock/workspace' } }],
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => {},
    show: () => {},
  }),
  showErrorMessage: () => {},
  showWarningMessage: () => {},
  showInformationMessage: () => {},
};

export const Uri = {
  joinPath: (...args: any[]) => ({ fsPath: args.map(String).join('/') }),
  file: (path: string) => ({ fsPath: path }),
};

export const ViewColumn = { One: 1 };
export const commands = { executeCommand: async () => {} };
