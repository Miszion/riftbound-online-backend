import * as AWS from 'aws-sdk';

const cognito = new AWS.CognitoIdentityServiceProvider();

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

interface RefreshTokenRequest {
  refreshToken: string;
}

interface TokenRefreshResponse {
  idToken: string;
  accessToken: string;
  expiresIn: number;
}

interface ApiResponse<T> {
  statusCode: number;
  body: string;
  headers: {
    'Content-Type': string;
    'Access-Control-Allow-Origin': string;
  };
}

export const handler = async (event: any): Promise<ApiResponse<any>> => {
  console.log('Token refresh request:', event);

  try {
    const body: RefreshTokenRequest = JSON.parse(event.body);
    const { refreshToken } = body;

    if (!refreshToken) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: 'Missing refresh token',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }

    // Refresh tokens using Cognito
    const params: AWS.CognitoIdentityServiceProvider.InitiateAuthRequest = {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    };

    const response = await cognito.initiateAuth(params).promise();

    if (!response.AuthenticationResult) {
      return {
        statusCode: 401,
        body: JSON.stringify({
          error: 'Failed to refresh token',
        }),
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      };
    }

    const tokenResponse: TokenRefreshResponse = {
      idToken: response.AuthenticationResult.IdToken || '',
      accessToken: response.AuthenticationResult.AccessToken || '',
      expiresIn: response.AuthenticationResult.ExpiresIn || 3600,
    };

    return {
      statusCode: 200,
      body: JSON.stringify(tokenResponse),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  } catch (error: any) {
    console.error('Token refresh error:', error);

    let statusCode = 500;
    let errorMessage = 'Internal server error';

    if (error.code === 'NotAuthorizedException') {
      statusCode = 401;
      errorMessage = 'Invalid refresh token';
    } else if (error.code === 'InvalidParameterException') {
      statusCode = 400;
      errorMessage = 'Invalid parameters';
    }

    return {
      statusCode,
      body: JSON.stringify({
        error: errorMessage,
        code: error.code,
      }),
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    };
  }
};
