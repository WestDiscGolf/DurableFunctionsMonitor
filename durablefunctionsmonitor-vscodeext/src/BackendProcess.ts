const portscanner = require('portscanner');

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as killProcessTree from 'tree-kill';
import axios from 'axios';
import { spawn, ChildProcess } from 'child_process';

import {
    GetAccountNameFromConnectionString, GetAccountKeyFromConnectionString,
    GetTableEndpointFromConnectionString, CreateAuthHeadersForTableStorage
} from "./Helpers";

import * as SharedConstants from './SharedConstants';
import { Settings } from './Settings';

export class StorageConnectionSettings {
    storageConnString: string = '';
    hubName: string = '';

    static areEqual(first: StorageConnectionSettings, second: StorageConnectionSettings): boolean {
        return first.storageConnString.toLowerCase() === second.storageConnString.toLowerCase()
            && first.hubName.toLowerCase() === second.hubName.toLowerCase();
    }

    static maskStorageConnString(connString: string): string{
        return connString.replace(/AccountKey=[^;]+/gi, 'AccountKey=*****');
    }
}

// Some info about the running backend
export class BackendProperties {
    backendUrl: string = '';
    accountName: string = '';
    hubName: string = '';
}

// Responsible for running the backend process
export class BackendProcess {

    constructor(private _binariesFolder: string,
        private _storageConnectionSettings: StorageConnectionSettings,
        private _log: (l: string) => void)
    {}

    // Task Hub credentials
    get storageConnectionSettings(): StorageConnectionSettings {
        return this._storageConnectionSettings;
    }

    // Information about the started backend (if it was successfully started)
    get backendProperties(): BackendProperties | null {
        return this._backendProperties;
    }

    // Kills the pending backend process
    cleanup(): Promise<any> | undefined {

        this._backendPromise = null;
        this._backendProperties = null;

        if (!this._funcProcess) {
            return;
        }

        console.log('Killing func process...');

        return new Promise((resolve) => {

            // The process is a shell. So to stop func.exe, we need to kill the entire process tree.
            killProcessTree(this._funcProcess!.pid, resolve);
            this._funcProcess = null;
        });
    }

    protected get backendCommunicationNonce(): string { return this._backendCommunicationNonce; }

    // Ensures that the backend is running (starts it, if needed) and returns its properties
    protected getBackend(): Promise<void> {

        // Only starting one backend instance per VsCode instance
        if (!!this._backendPromise) {
            return this._backendPromise;
        }

        this._backendPromise = new Promise<void>((resolve, reject) => {

            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Starting the backend `,
                cancellable: true
            }, (progress, token) => new Promise(stopProgress => {

                // Starting the backend on a first available port
                portscanner.findAPortNotInUse(37072, 38000).then((portNr: number) => {

                    const backendUrl = Settings().backendBaseUrl.replace('{portNr}', portNr.toString());
                    progress.report({ message: backendUrl });

                    // Checking whether the provided credentials are valid, but doing this in parallel.
                    const checkCredentialsPromise = this.checkStorageCredentials();

                    // Now running func.exe in backend folder
                    this.startBackendOnPort(portNr, backendUrl, token)
                        .then(resolve, err => {

                            // If credentials check failed, then returning its error. Otherwise returning whatever returned by the process.
                            checkCredentialsPromise.then(() => { reject(err);}, reject);
                        })
                        .finally(stopProgress);

                }, (err: any) => { stopProgress(); reject(`Failed to choose port for backend: ${err.message}`); });
            }));
        });

        // Allowing the user to try again
        this._backendPromise.catch(() => {
            this.cleanup();
        });

        return this._backendPromise;
    }
    
    // Reference to the shell instance running func.exe
    private _funcProcess: ChildProcess | null = null;

    // Promise that resolves when the backend is started successfully
    private _backendPromise: Promise<void> | null = null;

    // Information about the started backend (if it was successfully started)
    private _backendProperties: BackendProperties | null = null;

    // A nonce for communicating with the backend
    private _backendCommunicationNonce = crypto.randomBytes(64).toString('base64');

    // Runs the backend Function instance on some port
    private startBackendOnPort(portNr: number,
        backendUrl: string,
        cancelToken: vscode.CancellationToken): Promise<void> {

        console.log(`Attempting to start the backend on ${backendUrl}...`);

        const env: any = {
            'AzureWebJobsStorage': this.storageConnectionSettings.storageConnString,
            'DFM_HUB_NAME': this.storageConnectionSettings.hubName
        };

        env[SharedConstants.NonceEnvironmentVariableName] = this._backendCommunicationNonce;

        this._funcProcess = spawn('func', ['start', '--port', portNr.toString(), '--csharp'], {
            cwd: this._binariesFolder,
            shell: true,
            env
        });

        this._funcProcess.stdout.on('data', (data) => {
            this._log(data.toString());
        });

        return new Promise<void>((resolve, reject) => {

            this._funcProcess!.stderr.on('data', (data) => {
                this._log(`ERROR: ${data.toString()}`);
                reject(`Func: ${data.toString()}`);
            });

            console.log(`Waiting for ${backendUrl} to respond...`);

            // Waiting for the backend to be ready
            const timeoutInSeconds = Settings().backendTimeoutInSeconds;
            const intervalInMs = 500, numOfTries = timeoutInSeconds * 1000 / intervalInMs;
            var i = numOfTries;
            const intervalToken = setInterval(() => {

                const headers: any = {};
                headers[SharedConstants.NonceHeaderName] = this._backendCommunicationNonce;

                // Pinging the backend and returning its URL when ready
                axios.get(backendUrl + '/about', { headers }).then(response => {
                    console.log(`The backend is now running on ${backendUrl}`);
                    clearInterval(intervalToken);

                    this._backendProperties = {
                        backendUrl,
                        accountName: response.data.accountName,
                        hubName: response.data.hubName
                    };

                    resolve();
                });

                if (cancelToken.isCancellationRequested) {

                    clearInterval(intervalToken);
                    reject(`Cancelled by the user`);

                } else if (--i <= 0) {
                    console.log(`Timed out waiting for the backend!`);
                    clearInterval(intervalToken);
                    reject(`No response within ${timeoutInSeconds} seconds. Ensure you have the latest Azure Functions Core Tools installed globally.`);
                }

            }, intervalInMs);
        });
    }

    // Checks Connection String and Hub Name by making a simple GET against the storage table
    private checkStorageCredentials(): Promise<void> {
        return new Promise<void>((resolve, reject) => {

            const accountName = GetAccountNameFromConnectionString(this.storageConnectionSettings.storageConnString);
            const accountKey = GetAccountKeyFromConnectionString(this.storageConnectionSettings.storageConnString);

            if (!accountName) {
                reject(`The provided Storage Connection String doesn't contain a valid accountName.`);
                return;
            }

            if (!accountKey) {
                reject(`The provided Storage Connection String doesn't contain a valid accountKey.`);
                return;
            }

            const tableEndpoint = GetTableEndpointFromConnectionString(this.storageConnectionSettings.storageConnString);

            // Trying to read 1 record from XXXInstances table
            const instancesTableUrl = `${this.storageConnectionSettings.hubName}Instances`;
            const authHeaders = CreateAuthHeadersForTableStorage(accountName, accountKey, instancesTableUrl);
            const uri = `${tableEndpoint}${instancesTableUrl}?$top=1`;
            axios.get(uri, { headers: authHeaders }).then(() => {
                resolve();
            }, (err) => {
                reject(`The provided Storage Connection String and/or Hub Name seem to be invalid. ${err.message}`);
            });
        });
    }
}