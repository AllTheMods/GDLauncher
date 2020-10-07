import path from 'path';
import { app } from 'electron';
import fse from 'fs-extra';
import log from 'electron-log';
import { promises as fs } from 'fs';
import pMap from 'p-map';
import lockfile from 'lockfile';
import nsfw from 'nsfw';
import murmur from 'murmur2-calculator';
import { getAddon, getAddonsByFingerprint } from '../../common/api';
import {
  convertCompletePathToInstance,
  isInstanceFolderPath,
  isMod,
  normalizeModData
} from '../../common/utils';
import { sendMessage } from './messageListener';
import EV from '../../common/messageEvents';
import generateMessageId from '../../common/utils/generateMessageId';
import PromiseQueue from '../../common/utils/PromiseQueue';

// eslint-disable-next-line
export let INSTANCES = {};

// eslint-disable-next-line
export const initializeInstances = async () => {
  const instancesPath = path.join(app.getPath('userData'), 'instances');

  // Initially read from disk
  INSTANCES = await getInstances(instancesPath);
  sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
  INSTANCES = await modsFingerprintsScan(instancesPath);
  sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);

  // Initialize listener
  startListener(instancesPath).catch(log.error);
};

const isDirectory = source => fs.lstat(source).then(r => r.isDirectory());

const getDirectories = async source => {
  const dirs = await fs.readdir(source);
  return Promise.all(
    dirs
      .map(name => path.join(source, name))
      .filter(isDirectory)
      .map(dir => path.basename(dir))
  );
};

const getInstances = async instancesPath => {
  const mapFolderToInstance = async instance => {
    try {
      const configPath = path.join(
        path.join(instancesPath, instance, 'config.json')
      );
      const config = await fse.readJSON(configPath);
      if (!config.modloader) {
        throw new Error(`Config for ${instance} could not be parsed`);
      }

      return {
        ...config,
        name: instance
      };
    } catch (err) {
      console.error(err);
    }
    return null;
  };
  const folders = await getDirectories(instancesPath);
  const instances = await pMap(folders, mapFolderToInstance, {
    concurrency: 5
  });
  const hashMap = {};
  // eslint-disable-next-line
  for (const instance of instances) {
    // eslint-disable-next-line
    if (!instance) continue;
    hashMap[instance.name] = instance;
  }

  return hashMap;
};

const modsFingerprintsScan = async instancesPath => {
  const mapFolderToInstance = async instance => {
    try {
      const configPath = path.join(
        path.join(instancesPath, instance, 'config.json')
      );
      const config = await fse.readJSON(configPath);

      if (!config.modloader) {
        throw new Error(`Config for ${instance} could not be parsed`);
      }

      const modsFolder = path.join(instancesPath, instance, 'mods');
      const modsFolderExists = await fse.pathExists(modsFolder);

      if (!modsFolderExists) return { ...config, name: instance };

      // Check if config.mods has a different number of mods than the actual number of mods

      // Count the actual mods inside the folder
      const files = await fs.readdir(modsFolder);

      const fileNamesToRemove = [];
      const missingMods = {};
      /* eslint-disable */
      // Check for new mods in local storage that are not present in config
      for (const file of files) {
        try {
          const completeFilePath = path.join(modsFolder, file);
          const stat = await fs.lstat(completeFilePath);
          if (stat.isFile() && isMod(completeFilePath, instancesPath)) {
            // Check if file is in config
            if (!(config.mods || []).find(mod => mod.fileName === file)) {
              const murmurHash = await getFileMurmurHash2(completeFilePath);
              console.log(
                '[MODS SCANNER] Local mod not found in config',
                file,
                murmurHash
              );
              missingMods[file] = murmurHash;
            }
          }
        } catch {}
      }

      // Check for old mods in config that are not present on local storage
      for (const configMod of config.mods || []) {
        if (!files.includes(configMod.fileName)) {
          fileNamesToRemove.push(configMod.fileName);
          console.log(
            `[MODS SCANNER] Removing ${configMod.fileName} from config`
          );
        }
      }
      /* eslint-enable */

      let newMods = config.mods || [];

      if (Object.values(missingMods).length !== 0) {
        const { data } = await getAddonsByFingerprint(
          Object.values(missingMods)
        );

        const matches = await Promise.all(
          Object.entries(missingMods).map(async ([fileName, hash]) => {
            const exactMatch = (data.exactMatches || []).find(
              v => v.file.packageFingerprint === hash
            );
            const unmatched = (data.unmatchedFingerprints || []).find(
              v => v === hash
            );
            if (exactMatch) {
              let addonData = null;
              try {
                addonData = (await getAddon(exactMatch.file.projectId)).data;
                return {
                  ...normalizeModData(
                    exactMatch.file,
                    exactMatch.file.projectId,
                    addonData.name
                  ),
                  fileName
                };
              } catch {
                return {
                  fileName,
                  displayName: fileName,
                  packageFingerprint: hash
                };
              }
            }
            if (unmatched) {
              return {
                fileName,
                displayName: fileName,
                packageFingerprint: hash
              };
            }
            return null;
          })
        );

        newMods = [...newMods, ...matches];
      }

      const filterMods = newMods
        .filter(_ => _)
        .filter(v => !fileNamesToRemove.includes(v.fileName));

      const newConfig = {
        ...config,
        mods: filterMods
      };

      if (JSON.stringify(config) !== JSON.stringify(newConfig)) {
        await fse.outputJson(configPath, newConfig);
        return { ...newConfig, name: instance };
      }
      return { ...config, name: instance };
    } catch (err) {
      console.error(err);
    }
    return null;
  };

  const folders = await getDirectories(instancesPath);
  const instances = await pMap(folders, mapFolderToInstance, {
    concurrency: 5
  });
  const hashMap = {};
  // eslint-disable-next-line
  for (const instance of instances) {
    // eslint-disable-next-line
    if (!instance) continue;
    hashMap[instance.name] = instance;
  }

  return hashMap;
};

const getFileMurmurHash2 = filePath => {
  return new Promise((resolve, reject) => {
    return murmur(filePath).then(v => {
      if (v.toString().length === 0) reject();
      return resolve(v);
    });
  });
};

const startListener = async instancesPath => {
  // Real Time Scanner
  const Queue = new PromiseQueue();

  Queue.on('start', queueLength => {
    if (queueLength > 1) {
      sendMessage(EV.UPDATE_MOD_SYNC_STATE, generateMessageId(), queueLength);
    }
  });

  Queue.on('executed', queueLength => {
    if (queueLength > 1) {
      sendMessage(EV.UPDATE_MOD_SYNC_STATE, generateMessageId(), queueLength);
    }
  });

  Queue.on('end', () => {
    sendMessage(EV.UPDATE_MOD_SYNC_STATE, generateMessageId(), null);
  });

  const changesTracker = {};

  const processAddedFile = async (fileName, instanceName) => {
    const processChange = async () => {
      const instance = INSTANCES[instanceName];
      const isInConfig = (instance?.mods || []).find(
        mod => mod.fileName === path.basename(fileName)
      );
      try {
        const stat = await fs.lstat(fileName);

        if (instance?.mods && !isInConfig && stat.isFile() && instance) {
          // get murmur hash
          const murmurHash = await getFileMurmurHash2(fileName);
          const { data } = await getAddonsByFingerprint([murmurHash]);
          const exactMatch = (data.exactMatches || [])[0];
          const notMatch = (data.unmatchedFingerprints || [])[0];
          let mod = {};
          if (exactMatch) {
            let addon = null;
            try {
              addon = (await getAddon(exactMatch.file.projectId)).data;
              mod = normalizeModData(
                exactMatch.file,
                exactMatch.file.projectId,
                addon.name
              );
              mod.fileName = path.basename(fileName);
            } catch {
              mod = {
                fileName: path.basename(fileName),
                displayName: path.basename(fileName),
                packageFingerprint: murmurHash
              };
            }
          } else if (notMatch) {
            mod = {
              fileName: path.basename(fileName),
              displayName: path.basename(fileName),
              packageFingerprint: murmurHash
            };
          }
          const updatedInstance = INSTANCES[instanceName];
          const isStillNotInConfig = !(updatedInstance?.mods || []).find(
            m => m.fileName === path.basename(fileName)
          );
          if (isStillNotInConfig && updatedInstance) {
            console.log('[RTS] ADDING MOD', fileName, instanceName);

            INSTANCES[instanceName].mods.push(mod);
            sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
          }
        }
      } catch (err) {
        console.error(err);
      }
    };
    Queue.add(processChange);
  };

  const processRemovedFile = async (fileName, instanceName) => {
    const processChange = async () => {
      const instance = INSTANCES[instanceName];
      const isInConfig = (instance?.mods || []).find(
        mod => mod.fileName === path.basename(fileName)
      );
      if (isInConfig) {
        try {
          console.log('[RTS] REMOVING MOD', fileName, instanceName);
          INSTANCES[instanceName].mods = INSTANCES[instanceName].mods.filter(
            m => m.fileName !== path.basename(fileName)
          );
          sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
        } catch (err) {
          console.error(err);
        }
      }
    };
    Queue.add(processChange);
  };

  const processRenamedFile = async (fileName, oldInstanceName, newFilePath) => {
    const processChange = async () => {
      const modData = INSTANCES[oldInstanceName].mods.find(
        m => m.fileName === path.basename(fileName)
      );
      if (modData) {
        try {
          console.log('[RTS] RENAMING MOD', fileName, newFilePath, modData);
          INSTANCES[oldInstanceName].mods = [
            ...(INSTANCES[oldInstanceName].mods || []).filter(
              m => m.fileName !== path.basename(fileName)
            ),
            { ...modData, fileName: path.basename(newFilePath) }
          ];

          sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
        } catch (err) {
          console.error(err);
        }
      }
    };
    Queue.add(processChange);
  };

  const processAddedInstance = async instanceName => {
    const processChange = async () => {
      const instance = INSTANCES[instanceName];
      if (!instance) {
        const configPath = path.join(
          instancesPath,
          instanceName,
          'config.json'
        );
        try {
          const config = await fse.readJSON(configPath);

          if (!config.modloader) {
            throw new Error(`Config for ${instanceName} could not be parsed`);
          }
          console.log('[RTS] ADDING INSTANCE', instanceName);

          // ADD INSTANCE AND UPDATE
          INSTANCES[instanceName] = { ...config, name: instanceName };
          sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
        } catch (err) {
          console.warn(err);
        }
      }
    };
    Queue.add(processChange);
  };

  const processRemovedInstance = instanceName => {
    const processChange = async () => {
      if (INSTANCES[instanceName]) {
        console.log('[RTS] REMOVING INSTANCE', instanceName);
        delete INSTANCES[instanceName];
        sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
      }
    };
    Queue.add(processChange);
  };

  const processRenamedInstance = async (oldInstanceName, newInstanceName) => {
    const processChange = async () => {
      const instance = INSTANCES[newInstanceName];

      if (!instance) {
        try {
          const configPath = path.join(
            instancesPath,
            newInstanceName,
            'config.json'
          );
          const config = await fse.readJSON(configPath);
          if (!config.modloader) {
            throw new Error(
              `Config for ${newInstanceName} could not be parsed`
            );
          }
          console.log(
            `[RTS] RENAMING INSTANCE ${oldInstanceName} -> ${newInstanceName}`
          );
          INSTANCES[newInstanceName] = { ...config, name: newInstanceName };
          delete INSTANCES[oldInstanceName];
          sendMessage(EV.UPDATE_INSTANCES, generateMessageId(), INSTANCES);
        } catch (err) {
          console.error(err);
        }
      }
    };
    Queue.add(processChange);
  };

  const watcher = await nsfw(instancesPath, async events => {
    console.log(`Detected ${events.length} events from instances listener`);
    await Promise.all(
      events.map(async event => {
        // Using oldFile instead of newFile is intentional.
        // This is used to discard the ADD action dispatched alongside
        // the rename action.
        const completePath = path.join(
          event.directory,
          event.file || event.oldFile
        );

        const isRename = event.newFile && event.oldFile;

        if (
          (!isMod(completePath, instancesPath) &&
            !isInstanceFolderPath(completePath, instancesPath) &&
            !isRename) ||
          // When renaming, an ADD action is dispatched too. Try to discard that
          (event.action !== 2 && changesTracker[completePath]) ||
          // Ignore java legacy fixer
          path.basename(completePath) === '__JLF__.jar'
        ) {
          return;
        }
        if (event.action !== 2 && !changesTracker[completePath]) {
          // If we cannot find it in the hash table, it's a new event
          changesTracker[completePath] = {
            action: event.action,
            completed:
              event.action !== 0 ||
              (event.action === 0 &&
                isInstanceFolderPath(completePath, instancesPath)),
            ...(event.action === 3 && {
              newFilePath: path.join(event.newDirectory, event.newFile)
            })
          };
        }

        if (
          changesTracker[completePath] &&
          !changesTracker[completePath].completed &&
          (event.action === 2 || event.action === 0 || event.action === 1)
        ) {
          let fileHandle;
          try {
            await new Promise(resolve => setTimeout(resolve, 300));
            fileHandle = await fs.open(completePath, 'r+');
            changesTracker[completePath].completed = true;
          } finally {
            // Do nothing, simply not completed..
            // Remember to close the file handler
            if (fileHandle !== undefined) {
              await fileHandle.close();
            }
          }
        }
      })
    );

    // Handle edge case where MOD-REMOVE is called before INSTANCE-REMOVE
    Object.entries(changesTracker).forEach(
      async ([fileName, { action, completed }]) => {
        if (
          isInstanceFolderPath(fileName, instancesPath) &&
          action === 1 &&
          completed
        ) {
          const instanceName = convertCompletePathToInstance(
            fileName,
            instancesPath
          )
            .substr(1)
            .split(path.sep)[0];
          // Check if we can find any other action with this instance name
          Object.entries(changesTracker).forEach(([file, { action: act }]) => {
            if (isMod(file, instancesPath) && act === 1) {
              const instName = convertCompletePathToInstance(
                file,
                instancesPath
              )
                .substr(1)
                .split(path.sep)[0];
              if (instanceName === instName) {
                delete changesTracker[file];
              }
            }
          });
        }
      }
    );

    Object.entries(changesTracker).map(
      async ([fileName, { action, completed, newFilePath }]) => {
        const filePath = newFilePath || fileName;
        // Events are dispatched 3 times. Wait for 3 dispatches to be sure
        // that the action was completely executed
        if (completed) {
          // Remove the current file from the tracker.
          // Using fileName instead of filePath is intentional for the RENAME/ADD issue
          delete changesTracker[fileName];

          // Infer the instance name from the full path
          const instanceName = convertCompletePathToInstance(
            filePath,
            instancesPath
          )
            .substr(1)
            .split(path.sep)[0];

          // If we're installing a modpack we don't want to process anything
          const isLocked = await new Promise((resolve, reject) => {
            lockfile.check(
              path.join(instancesPath, instanceName, 'installing.lock'),
              (err, locked) => {
                if (err) reject(err);
                resolve(locked);
              }
            );
          });
          if (isLocked) return;

          if (
            isMod(fileName, instancesPath) &&
            INSTANCES[instanceName] &&
            action !== 3
          ) {
            if (action === 0) {
              processAddedFile(filePath, instanceName);
            } else if (action === 1) {
              processRemovedFile(filePath, instanceName);
            }
          } else if (
            action === 3 &&
            !isInstanceFolderPath(fileName, instancesPath) &&
            !isInstanceFolderPath(newFilePath, instancesPath)
          ) {
            // Infer the instance name from the full path
            const oldInstanceName = convertCompletePathToInstance(
              fileName,
              instancesPath
            )
              .substr(1)
              .split(path.sep)[0];
            if (
              oldInstanceName === instanceName &&
              isMod(newFilePath, instancesPath) &&
              isMod(fileName, instancesPath)
            ) {
              processRenamedFile(fileName, instanceName, newFilePath);
            } else if (
              oldInstanceName !== instanceName &&
              isMod(newFilePath, instancesPath) &&
              isMod(fileName, instancesPath)
            ) {
              processRemovedFile(fileName, oldInstanceName);
              processAddedFile(newFilePath, instanceName);
            } else if (
              !isMod(newFilePath, instancesPath) &&
              isMod(fileName, instancesPath)
            ) {
              processRemovedFile(fileName, oldInstanceName);
            } else if (
              isMod(newFilePath, instancesPath) &&
              !isMod(fileName, instancesPath)
            ) {
              processAddedFile(newFilePath, instanceName);
            }
          } else if (isInstanceFolderPath(filePath, instancesPath)) {
            if (action === 0) {
              processAddedInstance(instanceName);
            } else if (action === 1) {
              processRemovedInstance(instanceName);
            } else if (action === 3) {
              const oldInstanceName = convertCompletePathToInstance(
                fileName,
                instancesPath
              )
                .substr(1)
                .split(path.sep)[0];
              processRenamedInstance(oldInstanceName, instanceName);
            }
          }
        }
      }
    );
  });
  log.log('Started listener');
  return watcher.start();
};
