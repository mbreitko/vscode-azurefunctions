/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as opn from 'opn';
// tslint:disable-next-line:no-require-imports
import request = require('request-promise');
import * as semver from 'semver';
import * as vscode from 'vscode';
import { callWithTelemetryAndErrorHandling, DialogResponses, IActionContext, parseError } from 'vscode-azureextensionui';
import { attemptToInstallLatestFunctionRuntime, getFuncPackageManager } from '../commands/createNewProject/validateFuncCoreToolsInstalled';
import { isWindows, PackageManager, ProjectRuntime } from '../constants';
import { ext } from '../extensionVariables';
import { localize } from '../localize';
import { getFuncExtensionSetting, updateGlobalSetting } from '../ProjectSettings';
import { cpUtils } from './cpUtils';

export namespace functionRuntimeUtils {
    enum FunctionRuntimeTag {
        latest = 1,
        core = 2
    }

    export async function validateFunctionRuntime(): Promise<void> {
        await callWithTelemetryAndErrorHandling('azureFunctions.validateFunctionRuntime', ext.reporter, undefined, async function (this: IActionContext): Promise<void> {
            this.suppressErrorDisplay = true;
            this.properties.isActivationEvent = 'true';
            const settingKey: string = 'showCoreToolsWarning';
            if (getFuncExtensionSetting<boolean>(settingKey)) {
                const localVersion: string | null = await getLocalFunctionRuntimeVersion();
                if (localVersion === null) {
                    return;
                }
                this.properties.localVersion = localVersion;
                const major: number = semver.major(localVersion);
                const newestVersion: string | undefined = await getNewestFunctionRuntimeVersion(major, this);
                if (!newestVersion) {
                    return;
                }

                if (semver.gt(newestVersion, localVersion)) {
                    const packageManager: PackageManager | undefined = await getFuncPackageManager(true /* isFuncInstalled */);
                    let message: string = localize(
                        'azFunc.outdatedFunctionRuntime',
                        'Update your Azure Functions Core Tools ({0}) to the latest ({1}) for the best experience.',
                        localVersion,
                        newestVersion
                    );
                    const v2: string = localize('v2BreakingChanges', 'v2 is in preview and may have breaking changes (which are automatically applied to Azure).');
                    if (major === FunctionRuntimeTag.core) {
                        message += ` ${v2}`;
                    }
                    const update: vscode.MessageItem = { title: 'Update' };
                    let result: vscode.MessageItem;

                    do {
                        result = packageManager !== undefined ? await ext.ui.showWarningMessage(message, update, DialogResponses.learnMore, DialogResponses.dontWarnAgain) :
                            await ext.ui.showWarningMessage(message, DialogResponses.learnMore, DialogResponses.dontWarnAgain);
                        if (result === DialogResponses.learnMore) {
                            // tslint:disable-next-line:no-unsafe-any
                            opn('https://aka.ms/azFuncOutdated');
                        } else if (result === update) {
                            switch (major) {
                                case FunctionRuntimeTag.latest:
                                    // tslint:disable-next-line:no-non-null-assertion
                                    await attemptToInstallLatestFunctionRuntime(packageManager!, 'v1');
                                case FunctionRuntimeTag.core:
                                    // tslint:disable-next-line:no-non-null-assertion
                                    await attemptToInstallLatestFunctionRuntime(packageManager!, 'v2');
                                default:
                                    break;
                            }
                        } else if (result === DialogResponses.dontWarnAgain) {
                            await updateGlobalSetting(settingKey, false);
                        }
                    }
                    while (result === DialogResponses.learnMore);
                }
            }
        });
    }

    export async function tryGetLocalRuntimeVersion(): Promise<ProjectRuntime | undefined> {
        if (!isWindows) {
            return ProjectRuntime.beta;
        } else {
            try {
                const version: string | null = await getLocalFunctionRuntimeVersion();
                if (version !== null) {
                    switch (semver.major(version)) {
                        case 2:
                            return ProjectRuntime.beta;
                        case 1:
                            return ProjectRuntime.one;
                        default:
                            return undefined;
                    }
                }
            } catch (err) {
                // swallow errors and return undefined
            }

            return undefined;
        }
    }

    async function getLocalFunctionRuntimeVersion(): Promise<string | null> {
        // https://github.com/Microsoft/vscode-azurefunctions/issues/343
        const versionInfo: string = await cpUtils.executeCommand(undefined, undefined, 'func');
        const matchResult: RegExpMatchArray | null = versionInfo.match(/(?:.*)Azure Functions Core Tools (.*)/);
        if (matchResult !== null) {
            let localVersion: string = matchResult[1].replace(/[()]/g, '').trim(); // remove () and whitespace
            // this is a fix for a bug currently in the Function CLI
            if (localVersion === '220.0.0-beta.0') {
                localVersion = '2.0.1-beta.25';
            }
            return semver.valid(localVersion);
        }
        return null;
    }

    async function getNewestFunctionRuntimeVersion(major: number, actionContext: IActionContext): Promise<string | undefined> {
        try {
            const npmRegistryUri: string = 'https://aka.ms/W2mvv3';
            type distTags = { core: string, docker: string, latest: string };
            const distTags: distTags = <distTags>JSON.parse((await <Thenable<string>>request(npmRegistryUri).promise()));
            switch (major) {
                case FunctionRuntimeTag.latest:
                    return distTags.latest;
                case FunctionRuntimeTag.core:
                    return distTags.core;
                default:
            }
        } catch (error) {
            actionContext.properties.latestRuntimeError = parseError(error).message;
        }

        return undefined;
    }
}
