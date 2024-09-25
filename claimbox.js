const fs = require('fs');
require('colors');
const solana = require('@solana/web3.js');
const axios = require('axios').default;
const base58 = require('bs58');
const nacl = require('tweetnacl');
const { connection, delay } = require('./solanaUtils');
const { HEADERS } = require('./headers');
const { displayHeader } = require('./displayUtils');
const readlineSync = require('readline-sync');
const moment = require('moment');

const PRIVATE_KEYS = JSON.parse(fs.readFileSync('privateKeys.json', 'utf-8'));

function getKeypair(privateKey) {
  const decodedPrivateKey = base58.decode(privateKey);
  return solana.Keypair.fromSecretKey(decodedPrivateKey);
}

async function getToken(privateKey) {
  try {
    const { data } = await axios({
      url: 'https://odyssey-api-beta.sonic.game/auth/sonic/challenge',
      params: {
        wallet: getKeypair(privateKey).publicKey,
      },
      headers: HEADERS,
    });

    const sign = nacl.sign.detached(
      Buffer.from(data.data),
      getKeypair(privateKey).secretKey
    );
    const signature = Buffer.from(sign).toString('base64');
    const publicKey = getKeypair(privateKey).publicKey;
    const encodedPublicKey = Buffer.from(publicKey.toBytes()).toString(
      'base64'
    );
    const response = await axios({
      url: 'https://odyssey-api-beta.sonic.game/auth/sonic/authorize',
      method: 'POST',
      headers: HEADERS,
      data: {
        address: publicKey,
        address_encoded: encodedPublicKey,
        signature,
      },
    });

    return response.data.data.token;
  } catch (error) {
    console.log(`Error fetching token: ${error}`.red);
  }
}

async function getProfile(token) {
  try {
    const { data } = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/rewards/info',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });

    return data.data;
  } catch (error) {
    console.log(`Error fetching profile: ${error}`.red);
  }
}

async function doTransactions(tx, keypair, retries = 3) {
  try {
    const bufferTransaction = tx.serialize();
    const signature = await connection.sendRawTransaction(bufferTransaction);
    await connection.confirmTransaction(signature);
    return signature;
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying transaction... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return doTransactions(tx, keypair, retries - 1);
    } else {
      console.log(`Error in transaction: ${error}`.red);
      throw error;
    }
  }
}

async function openMysteryBox(token, keypair, retries = 3) {
  try {
    const { data } = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/rewards/mystery-box/build-tx',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });

    const txBuffer = Buffer.from(data.data.hash, 'base64');
    const tx = solana.Transaction.from(txBuffer);
    tx.partialSign(keypair);
    const signature = await doTransactions(tx, keypair);
    const response = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/rewards/mystery-box/open',
      method: 'POST',
      headers: { ...HEADERS, Authorization: token },
      data: {
        hash: signature,
      },
    });

    return response.data;
  } catch (error) {
    if (retries > 0) {
      console.log(
        `Retrying opening mystery box... (${retries} retries left)`.yellow
      );
      await new Promise((res) => setTimeout(res, 1000));
      return openMysteryBox(token, keypair, retries - 1);
    } else {
      console.log(`Error opening mystery box: ${error}`.red);
      throw error;
    }
  }
}

async function dailyClaim(token, retries = 3) {
  let counter = 1;
  const maxCounter = 3;

  try {
    const fetchDailyResponse = await fetchDaily(token);

    console.log(
      `[ ${moment().format(
        'HH:mm:ss'
      )} ] Your total transactions: ${fetchDailyResponse}`.blue
    );

    if (fetchDailyResponse > 10) {
      while (counter <= maxCounter) {
        try {
          const { data } = await axios({
            url: 'https://odyssey-api.sonic.game/user/transactions/rewards/claim',
            method: 'POST',
            headers: { ...HEADERS, Authorization: token },
            data: {
              stage: counter,
            },
          });

          console.log(
            `[ ${moment().format(
              'HH:mm:ss'
            )} ] Daily claim for stage ${counter} has been successful! Stage: ${counter} | Status: ${
              data.data.claimed
            }`.green
          );

          counter++;
        } catch (error) {
          if (error.response.data.message === 'interact task not finished') {
            console.log(
              `[ ${moment().format(
                'HH:mm:ss'
              )} ] Error claiming for stage ${counter}: ${
                error.response.data.message
              }`.red
            );
            counter++;
          } else if (
            error.response &&
            (error.response.data.code === 100015 ||
              error.response.data.code === 100016)
          ) {
            console.log(
              `[ ${moment().format(
                'HH:mm:ss'
              )} ] Already claimed for stage ${counter}, proceeding to the next stage...`
                .cyan
            );
            counter++;
          } else {
            console.log(
              `[ ${moment().format('HH:mm:ss')} ] Error claiming: ${
                error.response.data.message
              }`.red
            );
          }
        } finally {
          await delay(1000);
        }
      }

      console.log(`All stages processed or max stage reached.`.green);
    } else {
      throw new Error('Not enough transactions to claim rewards.');
    }
  } catch (error) {
    if (retries > 0) {
      console.log(`Retrying daily claim... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return dailyClaim(token, retries - 1);
    } else {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Error in daily claim: ${
          error.message
        }`.red
      );
    }
  }
}

async function dailyLogin(token, keypair, retries = 3) {
  try {
    const { data } = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/check-in/transaction',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });

    const txBuffer = Buffer.from(data.data.hash, 'base64');
    const tx = solana.Transaction.from(txBuffer);
    tx.partialSign(keypair);
    const signature = await doTransactions(tx, keypair);

    const response = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/check-in',
      method: 'POST',
      headers: { ...HEADERS, Authorization: token },
      data: {
        hash: signature,
      },
    });

    return response.data;
  } catch (error) {
    if (error.response.data.message === 'current account already checked in') {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Error in daily login: ${
          error.response.data.message
        }`.red
      );
    } else if (retries > 0) {
      console.log(`Retrying daily login... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return dailyLogin(token, keypair, retries - 1);
    } else {
      console.log(
        `[ ${moment().format('HH:mm:ss')} ] Error claiming: ${
          error.response.data.message
        }`.red
      );
    }
  }
}

async function fetchDaily(token) {
  try {
    const { data } = await axios({
      url: 'https://odyssey-api-beta.sonic.game/user/transactions/state/daily',
      method: 'GET',
      headers: { ...HEADERS, Authorization: token },
    });

    return data.data.total_transactions;
  } catch (error) {
    console.log(
      `[ ${moment().format('HH:mm:ss')} ] Error in daily fetching: ${
        error.response.data.message
      }`.red
    );
  }
}

async function processPrivateKey(privateKey, method, retries = 3) {
  try {
    const publicKey = getKeypair(privateKey).publicKey.toBase58();
    const token = await getToken(privateKey);
    const profile = await getProfile(token);

    if (profile.wallet_balance > 0) {
      const balance = profile.wallet_balance / solana.LAMPORTS_PER_SOL;
      const ringBalance = profile.ring;
      const availableBoxes = profile.ring_monitor;
      console.log(
        `Hello ${publicKey}! Welcome to our bot. Here are your details:`.green
      );
      console.log(`Solana Balance: ${balance} SOL`.green);
      console.log(`Ring Balance: ${ringBalance}`.green);
      console.log(`Available Box(es): ${availableBoxes}`.green);
      console.log('');

      switch (method) {
        case '1':
          console.log(`[ ${moment().format('HH:mm:ss')} ] Please wait...`.yellow);
          await dailyClaim(token);
          console.log(
            `[ ${moment().format('HH:mm:ss')} ] All tasks completed!`.cyan
          );
          break;
        case '2':
          console.log(`[ ${moment().format('HH:mm:ss')} ] Please wait...`.yellow);
          const totalClaim = availableBoxes;
          for (let i = 0; i < totalClaim; i++) {
            try {
              const openedBox = await openMysteryBox(token, getKeypair(privateKey));
              if (openedBox.data.success) {
                console.log(
                  `[ ${moment().format(
                    'HH:mm:ss'
                  )} ] Box opened successfully! Status: ${
                    openedBox.status
                  } | Amount: ${openedBox.data.amount}`.green
                );
              }
            } catch (error) {
              console.log(`Error opening box: ${error}`.red);
            }
          }
          console.log(
            `[ ${moment().format('HH:mm:ss')} ] All tasks completed!`.cyan
          );
          break;
        case '3':
          console.log(`[ ${moment().format('HH:mm:ss')} ] Please wait...`.yellow);
          const claimLogin = await dailyLogin(token, getKeypair(privateKey));
          if (claimLogin) {
            console.log(
              `[ ${moment().format(
                'HH:mm:ss'
              )} ] Daily login has been success! Status: ${
                claimLogin.status
              } | Accumulative Days: ${claimLogin.data.accumulative_days}`.green
            );
          }
          console.log(
            `[ ${moment().format('HH:mm:ss')} ] All tasks completed!`.cyan
          );
          break;
        default:
          throw new Error('Invalid input method selected'.red);
      }
    } else {
      console.log(
        `There might be errors if you don't have sufficient balance or the RPC is down. Please ensure your balance is sufficient and your connection is stable`
          .red
      );
    }
  } catch (error) {
    console.log(`Error processing private key: ${error}`.red);
    if (retries > 0) {
      console.log(`Retrying private key processing... (${retries} retries left)`.yellow);
      await new Promise((res) => setTimeout(res, 1000));
      return processPrivateKey(privateKey, method, retries - 1);
    }
  }
  console.log('');
}

(async () => {
  try {
    displayHeader();

    // Process all private keys with method '3' (daily login)
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const privateKey = PRIVATE_KEYS[i];
      await processPrivateKey(privateKey, '3');
    }

    // Process all private keys with method '1' (claim box)
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const privateKey = PRIVATE_KEYS[i];
      await processPrivateKey(privateKey, '1');
    }

    // Process all private keys with method '2' (open box)
    for (let i = 0; i < PRIVATE_KEYS.length; i++) {
      const privateKey = PRIVATE_KEYS[i];
      await processPrivateKey(privateKey, '2');
    }

    console.log('All private keys processed.'.cyan);
  } catch (error) {
    console.log(`Error in bot operation: ${error}`.red);
  } finally {
    console.log(
      'Thanks for having us! Subscribe: https://t.me/HappyCuanAirdrop'.magenta
    );
  }
})();
