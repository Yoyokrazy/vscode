/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { deepStrictEqual, fail, strictEqual } from 'assert';
import { VSBuffer } from 'vs/base/common/buffer';
import { Schemas } from 'vs/base/common/network';
import { join } from 'vs/base/common/path';
import { isWindows, OperatingSystem } from 'vs/base/common/platform';
import { env } from 'vs/base/common/process';
import { URI } from 'vs/base/common/uri';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TestConfigurationService } from 'vs/platform/configuration/test/common/testConfigurationService';
import { IFileService } from 'vs/platform/files/common/files';
import { TestInstantiationService } from 'vs/platform/instantiation/test/common/instantiationServiceMock';
import { IRemoteAgentEnvironment } from 'vs/platform/remote/common/remoteAgentEnvironment';
import { IStorageService } from 'vs/platform/storage/common/storage';
import { fetchBashHistory, fetchPwshHistory, fetchZshHistory, ITerminalPersistedHistory, TerminalPersistedHistory } from 'vs/workbench/contrib/terminal/common/history';
import { IRemoteAgentConnection, IRemoteAgentService } from 'vs/workbench/services/remote/common/remoteAgentService';
import { TestStorageService } from 'vs/workbench/test/common/workbenchTestServices';

function getConfig(limit: number) {
	return {
		terminal: {
			integrated: {
				shellIntegration: {
					history: limit
				}
			}
		}
	};
}

const expectedCommands = [
	'single line command',
	'git commit -m "A wrapped line in pwsh history\n\nSome commit description\n\nFixes #xyz"',
	'git status',
	'two "\nline"'
];

suite('Terminal history', () => {
	suite('TerminalPersistedHistory', () => {
		let history: ITerminalPersistedHistory<number>;
		let instantiationService: TestInstantiationService;
		let storageService: TestStorageService;
		let configurationService: TestConfigurationService;

		setup(() => {
			configurationService = new TestConfigurationService(getConfig(5));
			storageService = new TestStorageService();
			instantiationService = new TestInstantiationService();
			instantiationService.set(IConfigurationService, configurationService);
			instantiationService.set(IStorageService, storageService);

			history = instantiationService.createInstance(TerminalPersistedHistory, 'test');
		});

		test('should support adding items to the cache and respect LRU', () => {
			history.add('foo', 1);
			deepStrictEqual(Array.from(history.entries), [
				['foo', 1]
			]);
			history.add('bar', 2);
			deepStrictEqual(Array.from(history.entries), [
				['foo', 1],
				['bar', 2]
			]);
			history.add('foo', 1);
			deepStrictEqual(Array.from(history.entries), [
				['bar', 2],
				['foo', 1]
			]);
		});

		test('should support removing specific items', () => {
			history.add('1', 1);
			history.add('2', 2);
			history.add('3', 3);
			history.add('4', 4);
			history.add('5', 5);
			strictEqual(Array.from(history.entries).length, 5);
			history.add('6', 6);
			strictEqual(Array.from(history.entries).length, 5);
		});

		test('should limit the number of entries based on config', () => {
			history.add('1', 1);
			history.add('2', 2);
			history.add('3', 3);
			history.add('4', 4);
			history.add('5', 5);
			strictEqual(Array.from(history.entries).length, 5);
			history.add('6', 6);
			strictEqual(Array.from(history.entries).length, 5);
			configurationService.setUserConfiguration('terminal', getConfig(2).terminal);
			configurationService.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: () => true } as any);
			strictEqual(Array.from(history.entries).length, 2);
			history.add('7', 7);
			strictEqual(Array.from(history.entries).length, 2);
			configurationService.setUserConfiguration('terminal', getConfig(3).terminal);
			configurationService.onDidChangeConfigurationEmitter.fire({ affectsConfiguration: () => true } as any);
			strictEqual(Array.from(history.entries).length, 2);
			history.add('8', 8);
			strictEqual(Array.from(history.entries).length, 3);
			history.add('9', 9);
			strictEqual(Array.from(history.entries).length, 3);
		});

		test('should reload from storage service after recreation', () => {
			history.add('1', 1);
			history.add('2', 2);
			history.add('3', 3);
			strictEqual(Array.from(history.entries).length, 3);
			const history2 = instantiationService.createInstance(TerminalPersistedHistory, 'test');
			strictEqual(Array.from(history2.entries).length, 3);
		});
	});
	suite('fetchBashHistory', () => {
		let fileScheme: string;
		let filePath: string;
		const fileContent: string = [
			'single line command',
			'git commit -m "A wrapped line in pwsh history',
			'',
			'Some commit description',
			'',
			'Fixes #xyz"',
			'git status',
			'two "',
			'line"'
		].join('\n');

		let instantiationService: TestInstantiationService;
		let remoteConnection: Pick<IRemoteAgentConnection, 'remoteAuthority'> | null = null;
		let remoteEnvironment: Pick<IRemoteAgentEnvironment, 'os'> | null = null;

		setup(() => {
			instantiationService = new TestInstantiationService();
			instantiationService.stub(IFileService, {
				async readFile(resource: URI) {
					const expected = URI.from({ scheme: fileScheme, path: filePath });
					strictEqual(resource.scheme, expected.scheme);
					strictEqual(resource.path, expected.path);
					return { value: VSBuffer.fromString(fileContent) };
				}
			} as Pick<IFileService, 'readFile'>);
			instantiationService.stub(IRemoteAgentService, {
				async getEnvironment() { return remoteEnvironment; },
				getConnection() { return remoteConnection; }
			} as Pick<IRemoteAgentService, 'getConnection' | 'getEnvironment'>);
		});

		if (!isWindows) {
			test('local', async () => {
				filePath = join(env['HOME']!, '.bash_history');
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchBashHistory))!), expectedCommands);
			});
		}
		suite('remote', () => {
			let originalEnvValues: { HOME: string | undefined };
			setup(() => {
				originalEnvValues = { HOME: env['HOME'] };
				env['HOME'] = '/home/user';
				remoteConnection = { remoteAuthority: 'some-remote' };
				fileScheme = Schemas.vscodeRemote;
				filePath = '/home/user/.bash_history';
			});
			teardown(() => {
				if (originalEnvValues['HOME'] === undefined) {
					delete env['HOME'];
				} else {
					env['HOME'] = originalEnvValues['HOME'];
				}
			});
			test('Windows', async () => {
				remoteEnvironment = { os: OperatingSystem.Windows };
				strictEqual(await instantiationService.invokeFunction(fetchBashHistory), undefined);
			});
			test('macOS', async () => {
				remoteEnvironment = { os: OperatingSystem.Macintosh };
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchBashHistory))!), expectedCommands);
			});
			test('Linux', async () => {
				remoteEnvironment = { os: OperatingSystem.Linux };
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchBashHistory))!), expectedCommands);
			});
		});
	});
	suite('fetchZshHistory', () => {
		let fileScheme: string;
		let filePath: string;
		const fileContent: string = [
			': 1655252330:0;single line command',
			': 1655252330:0;git commit -m "A wrapped line in pwsh history\\',
			'\\',
			'Some commit description\\',
			'\\',
			'Fixes #xyz"',
			': 1655252330:0;git status',
			': 1655252330:0;two "\\',
			'line"'
		].join('\n');

		let instantiationService: TestInstantiationService;
		let remoteConnection: Pick<IRemoteAgentConnection, 'remoteAuthority'> | null = null;
		let remoteEnvironment: Pick<IRemoteAgentEnvironment, 'os'> | null = null;

		setup(() => {
			instantiationService = new TestInstantiationService();
			instantiationService.stub(IFileService, {
				async readFile(resource: URI) {
					const expected = URI.from({ scheme: fileScheme, path: filePath });
					strictEqual(resource.scheme, expected.scheme);
					strictEqual(resource.path, expected.path);
					return { value: VSBuffer.fromString(fileContent) };
				}
			} as Pick<IFileService, 'readFile'>);
			instantiationService.stub(IRemoteAgentService, {
				async getEnvironment() { return remoteEnvironment; },
				getConnection() { return remoteConnection; }
			} as Pick<IRemoteAgentService, 'getConnection' | 'getEnvironment'>);
		});

		if (!isWindows) {
			test('local', async () => {
				filePath = join(env['HOME']!, '.zsh_history');
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchZshHistory))!), expectedCommands);
			});
		}
		suite('remote', () => {
			let originalEnvValues: { HOME: string | undefined };
			setup(() => {
				originalEnvValues = { HOME: env['HOME'] };
				env['HOME'] = '/home/user';
				remoteConnection = { remoteAuthority: 'some-remote' };
				fileScheme = Schemas.vscodeRemote;
				filePath = '/home/user/.zsh_history';
			});
			teardown(() => {
				if (originalEnvValues['HOME'] === undefined) {
					delete env['HOME'];
				} else {
					env['HOME'] = originalEnvValues['HOME'];
				}
			});
			test('Windows', async () => {
				remoteEnvironment = { os: OperatingSystem.Windows };
				strictEqual(await instantiationService.invokeFunction(fetchZshHistory), undefined);
			});
			test('macOS', async () => {
				remoteEnvironment = { os: OperatingSystem.Macintosh };
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchZshHistory))!), expectedCommands);
			});
			test('Linux', async () => {
				remoteEnvironment = { os: OperatingSystem.Linux };
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchZshHistory))!), expectedCommands);
			});
		});
	});
	suite('fetchPwshHistory', () => {
		let fileScheme: string;
		let filePath: string;
		const fileContent: string = [
			'single line command',
			'git commit -m "A wrapped line in pwsh history`',
			'`',
			'Some commit description`',
			'`',
			'Fixes #xyz"',
			'git status',
			'two "`',
			'line"'
		].join('\n');

		let instantiationService: TestInstantiationService;
		let remoteConnection: Pick<IRemoteAgentConnection, 'remoteAuthority'> | null = null;
		let remoteEnvironment: Pick<IRemoteAgentEnvironment, 'os'> | null = null;

		setup(() => {
			instantiationService = new TestInstantiationService();
			instantiationService.stub(IFileService, {
				async readFile(resource: URI) {
					const expected = URI.from({ scheme: fileScheme, path: filePath });
					if (resource.scheme !== expected.scheme || resource.fsPath !== expected.fsPath) {
						fail(`Unexpected file scheme/path ${resource.scheme} ${resource.fsPath}`);
					}
					return { value: VSBuffer.fromString(fileContent) };
				}
			} as Pick<IFileService, 'readFile'>);
			instantiationService.stub(IRemoteAgentService, {
				async getEnvironment() { return remoteEnvironment; },
				getConnection() { return remoteConnection; }
			} as Pick<IRemoteAgentService, 'getConnection' | 'getEnvironment'>);
		});

		test('local', async () => {
			if (isWindows) {
				filePath = join(env['APPDATA']!, 'Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt');
			} else {
				filePath = join(env['HOME']!, '.local/share/powershell/PSReadline/ConsoleHost_history.txt');
			}
			deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchPwshHistory))!), expectedCommands);
		});
		suite('remote', () => {
			let originalEnvValues: { HOME: string | undefined; APPDATA: string | undefined };
			setup(() => {
				remoteConnection = { remoteAuthority: 'some-remote' };
				fileScheme = Schemas.vscodeRemote;
				originalEnvValues = { HOME: env['HOME'], APPDATA: env['APPDATA'] };
			});
			teardown(() => {
				if (originalEnvValues['HOME'] === undefined) {
					delete env['HOME'];
				} else {
					env['HOME'] = originalEnvValues['HOME'];
				}
				if (originalEnvValues['APPDATA'] === undefined) {
					delete env['APPDATA'];
				} else {
					env['APPDATA'] = originalEnvValues['APPDATA'];
				}
			});
			test('Windows', async () => {
				remoteEnvironment = { os: OperatingSystem.Windows };
				env['APPDATA'] = 'C:\\AppData';
				filePath = 'C:\\AppData\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt';
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchPwshHistory))!), expectedCommands);
			});
			test('macOS', async () => {
				remoteEnvironment = { os: OperatingSystem.Macintosh };
				env['HOME'] = '/home/user';
				filePath = '/home/user/.local/share/powershell/PSReadline/ConsoleHost_history.txt';
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchPwshHistory))!), expectedCommands);
			});
			test('Linux', async () => {
				remoteEnvironment = { os: OperatingSystem.Linux };
				env['HOME'] = '/home/user';
				filePath = '/home/user/.local/share/powershell/PSReadline/ConsoleHost_history.txt';
				deepStrictEqual(Array.from((await instantiationService.invokeFunction(fetchPwshHistory))!), expectedCommands);
			});
		});
	});
});
