import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface AuthStackProps extends cdk.StackProps {
  readonly environment: string;
}

export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly identityPool: cognito.CfnIdentityPool;
  public readonly apiEndpoint: string;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Create Cognito User Pool
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `riftbound-${props.environment}-pool`,
      selfSignUpEnabled: true,
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 12,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
        requireUppercase: true,
      },
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      standardAttributes: {
        email: {
          required: true,
          mutable: false,
        },
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
    });

    // Create User Pool Client
    this.userPoolClient = this.userPool.addClient('AppClient', {
      userPoolClientName: `riftbound-${props.environment}-client`,
      generateSecret: true,
      authFlows: {
        adminUserPassword: true,
        userPassword: true,
        custom: true,
        userSrp: true,
      },
      oAuth: {
        flows: {
          implicitCodeGrant: true,
          authorizationCodeGrant: true,
        },
        scopes: [cognito.OAuthScope.EMAIL, cognito.OAuthScope.OPENID, cognito.OAuthScope.PROFILE],
        callbackUrls: [
          'http://localhost:3000/callback',
          'https://riftbound.example.com/callback',
        ],
        logoutUrls: [
          'http://localhost:3000/logout',
          'https://riftbound.example.com/logout',
        ],
      },
      preventUserExistenceErrors: true,
    });

    // Add domain for hosted UI
    new cognito.UserPoolDomain(this, 'Domain', {
      userPool: this.userPool,
      cognitoDomain: {
        domainPrefix: `riftbound-${props.environment}`,
      },
    });

    // Create Cognito Identity Pool
    this.identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `riftbound-${props.environment}-identity`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: this.userPoolClient.userPoolClientId,
          providerName: this.userPool.userPoolProviderName,
          serverSideTokenCheck: false,
        },
      ],
    });

    // IAM role for authenticated users
    const authRole = new iam.Role(this, 'IdentityPoolAuthRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': this.identityPool.ref,
          },
          'ForAllValues:StringLike': {
            'cognito-identity.amazonaws.com:auth_type': 'authenticated',
          },
        },
        'sts:AssumeRoleWithWebIdentity'
      ),
    });

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: this.identityPool.ref,
      roles: {
        authenticated: authRole.roleArn,
      },
    });

    // Create Lambda execution role
    const lambdaRole = new iam.Role(this, 'LambdaExecutionRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    // Add Cognito permissions to Lambda role
    lambdaRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          'cognito-idp:AdminInitiateAuth',
          'cognito-idp:SignUp',
          'cognito-idp:AdminConfirmSignUp',
          'cognito-idp:AdminGetUser',
          'cognito-idp:AdminUserGlobalSignOut',
          'cognito-idp:InitiateAuth',
        ],
        resources: [this.userPool.userPoolArn],
      })
    );

    // Create Lambda functions
    const signInFunction = new lambda.Function(this, 'SignInFunction', {
      functionName: `riftbound-${props.environment}-sign-in`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset('../lambda/sign_in'),
      timeout: cdk.Duration.seconds(30),
      role: lambdaRole,
      environment: {
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const signUpFunction = new lambda.Function(this, 'SignUpFunction', {
      functionName: `riftbound-${props.environment}-sign-up`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset('../lambda/sign_up'),
      timeout: cdk.Duration.seconds(30),
      role: lambdaRole,
      environment: {
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    const refreshTokenFunction = new lambda.Function(this, 'RefreshTokenFunction', {
      functionName: `riftbound-${props.environment}-refresh-token`,
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'dist/index.handler',
      code: lambda.Code.fromAsset('../lambda/refresh_token'),
      timeout: cdk.Duration.seconds(30),
      role: lambdaRole,
      environment: {
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        COGNITO_CLIENT_ID: this.userPoolClient.userPoolClientId,
      },
      logRetention: logs.RetentionDays.ONE_WEEK,
    });

    // Create API Gateway
    const api = new apigateway.RestApi(this, 'AuthApi', {
      restApiName: `riftbound-${props.environment}-auth-api`,
      description: 'Authentication API for Riftbound Online',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    // Sign-in endpoint
    const signInResource = api.root.addResource('sign-in');
    signInResource.addMethod('POST', new apigateway.LambdaIntegration(signInFunction));

    // Sign-up endpoint
    const signUpResource = api.root.addResource('sign-up');
    signUpResource.addMethod('POST', new apigateway.LambdaIntegration(signUpFunction));

    // Refresh token endpoint
    const refreshTokenResource = api.root.addResource('refresh-token');
    refreshTokenResource.addMethod('POST', new apigateway.LambdaIntegration(refreshTokenFunction));

    this.apiEndpoint = api.url;

    // Output values
    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: `riftbound-${props.environment}-userpool-id`,
    });

    new cdk.CfnOutput(this, 'UserPoolArn', {
      value: this.userPool.userPoolArn,
      exportName: `riftbound-${props.environment}-userpool-arn`,
    });

    new cdk.CfnOutput(this, 'ClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: `riftbound-${props.environment}-client-id`,
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: this.identityPool.ref,
      exportName: `riftbound-${props.environment}-identity-pool-id`,
    });

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: this.apiEndpoint,
      exportName: `riftbound-${props.environment}-auth-api-endpoint`,
    });
  }
}
